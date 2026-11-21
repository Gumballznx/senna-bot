import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { finishPlan, planPartZip, sendPlanAsZips, sendDownloadedFile, safeName, FOLDER_MAX_FILES, defaultTmp } from './folderzip.js'

// Yandex Disk: arquivo ou pasta pública, pela API oficial pública (sem login).

const API = 'https://cloud-api.yandex.net/v1/disk/public/resources'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** Tira o link base (sem parâmetros e sem subcaminho). Retorna { key, sub } */
export function yandexParse(link) {
    const m = String(link).match(/(?:disk\.yandex\.[a-z.]+|yadi\.sk)\/(d|i)\/([\w-]+)((?:\/[^\s?#]+)*)/i)
    if (!m) return null
    let sub = ''
    try { sub = decodeURIComponent(m[3] || '') } catch (_) { sub = m[3] || '' }
    return { url: `https://yadi.sk/${m[1].toLowerCase()}/${m[2]}`, sub }
}

async function apiGet(endpoint, params) {
    const { data } = await axios.get(endpoint, { params, headers: { 'User-Agent': UA }, timeout: 30000, validateStatus: s => s < 500 })
    if (data?.error) throw new Error(data.message || 'O Yandex Disk recusou. O link é público?')
    return data
}

/** Lista recursivamente. Retorna o nó raiz já com os arquivos achatados. */
async function listAll(url, p = '/', prefix = '', depth = 0, acc = []) {
    if (depth > 6) return acc
    for (let offset = 0; ; offset += 100) {
        const d = await apiGet(API, { public_key: url, path: p, limit: 100, offset })
        const items = d?._embedded?.items || []
        for (const it of items) {
            if (it.type === 'dir') await listAll(url, it.path, `${prefix}${safeName(it.name)}/`, depth + 1, acc)
            else acc.push({ name: it.name, path: prefix, size: it.size || 0, ypath: it.path, mime: it.mime_type })
            if (acc.length > FOLDER_MAX_FILES) throw new Error(`Pasta com mais de ${FOLDER_MAX_FILES} arquivos.`)
        }
        if (items.length < 100) break
    }
    return acc
}

async function downloadHref(url, ypath) {
    const d = await apiGet(`${API}/download`, ypath ? { public_key: url, path: ypath } : { public_key: url })
    if (!d.href) throw new Error('Sem link de download.')
    return d.href
}

async function yandexFetch(item, dir, maxBytes) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const href = await downloadHref(item.url, item.ypath)
    const res = await axios.get(href, { responseType: 'stream', headers: { 'User-Agent': UA }, timeout: 60000, maxRedirects: 10 })
    const size = Number(res.headers['content-length']) || 0
    if (size > maxBytes) { res.data.destroy(); throw new Error(`Arquivo de ${(size / 1048576).toFixed(0)} MB passa do limite.`) }
    const out = path.join(dir, `yandex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeName(item.name)}`)
    await pipeline(res.data, fs.createWriteStream(out))
    return { filePath: out, name: item.name, size: fs.statSync(out).size }
}

/** Lê o link: arquivo único ou pasta (plano SEM baixar nada). */
export async function yandexPlan(link) {
    const parsed = yandexParse(link)
    if (!parsed) throw new Error('Link do Yandex Disk inválido.')
    const root = await apiGet(API, { public_key: parsed.url, path: parsed.sub || '/', limit: 1 })
    if (root.type === 'file') {
        return { kind: 'file', item: { name: root.name, path: '', size: root.size || 0, ypath: parsed.sub || undefined, url: parsed.url } }
    }
    const items = (await listAll(parsed.url, parsed.sub || '/')).map(i => ({ ...i, url: parsed.url }))
    if (!items.length) throw new Error('A pasta está vazia.')
    return { kind: 'folder', plan: finishPlan({ name: root.name || 'pasta', items }) }
}

export const yandexFolderPartZip = (plan, partIndex = 0, dir, onProgress) => planPartZip(plan, partIndex, yandexFetch, dir, onProgress)

/** Baixa e envia: arquivo (vídeo inteligente/documento) ou pasta (.zip em partes). */
export async function yandexSend(io, link, caption = '') {
    const r = await yandexPlan(link)
    if (r.kind === 'file') {
        const f = await yandexFetch(r.item, defaultTmp(), 1900 * 1024 * 1024)
        return sendDownloadedFile(io, f, caption)
    }
    return sendPlanAsZips(io, r.plan, yandexFetch, caption)
}
