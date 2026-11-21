import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { finishPlan, planPartZip, sendPlanAsZips, sendDownloadedFile, safeName, FOLDER_MAX_FILES, defaultTmp } from './folderzip.js'

// pCloud: arquivo ou pasta de link público (pcloud.link/publink/show?code=...).
// Contas têm região (US ou EU): tentamos os dois servidores da API.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const HOSTS = ['eapi.pcloud.com', 'api.pcloud.com']

export const pcloudCode = link => (String(link).match(/[?&]code=([A-Za-z0-9]+)/) || [])[1] || null

async function call(host, method, params) {
    const { data } = await axios.get(`https://${host}/${method}`, { params, headers: { 'User-Agent': UA }, timeout: 30000 })
    return data
}

async function findHost(code) {
    for (const host of HOSTS) {
        const d = await call(host, 'showpublink', { code }).catch(() => null)
        if (d && d.result === 0) return { host, meta: d.metadata }
    }
    throw new Error('Link do pCloud inválido, expirado ou não é público.')
}

function flatten(meta, prefix = '', acc = []) {
    for (const c of meta.contents || []) {
        if (c.isfolder) flatten(c, `${prefix}${safeName(c.name)}/`, acc)
        else acc.push({ name: c.name, path: prefix, size: Number(c.size) || 0, fileid: c.fileid })
        if (acc.length > FOLDER_MAX_FILES) throw new Error(`Pasta com mais de ${FOLDER_MAX_FILES} arquivos.`)
    }
    return acc
}

async function pcloudFetch(item, dir, maxBytes) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const d = await call(item.host, 'getpublinkdownload', { code: item.code, fileid: item.fileid })
    if (d.result !== 0 || !d.hosts?.length) throw new Error(d.error || 'Sem link de download.')
    const res = await axios.get(`https://${d.hosts[0]}${d.path}`, { responseType: 'stream', headers: { 'User-Agent': UA }, timeout: 60000, maxRedirects: 10 })
    const size = Number(res.headers['content-length']) || 0
    if (size > maxBytes) { res.data.destroy(); throw new Error(`Arquivo de ${(size / 1048576).toFixed(0)} MB passa do limite.`) }
    const out = path.join(dir, `pcloud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeName(item.name)}`)
    await pipeline(res.data, fs.createWriteStream(out))
    return { filePath: out, name: item.name, size: fs.statSync(out).size }
}

/** Lê o link: arquivo único ou pasta (plano SEM baixar nada). */
export async function pcloudPlan(link) {
    const code = pcloudCode(link)
    if (!code) throw new Error('Link do pCloud inválido.')
    const { host, meta } = await findHost(code)
    if (!meta.isfolder) {
        return { kind: 'file', item: { name: meta.name, path: '', size: Number(meta.size) || 0, fileid: meta.fileid, host, code } }
    }
    const items = flatten(meta).map(i => ({ ...i, host, code }))
    if (!items.length) throw new Error('A pasta está vazia.')
    return { kind: 'folder', plan: finishPlan({ name: meta.name || 'pasta', items }) }
}

export const pcloudFolderPartZip = (plan, partIndex = 0, dir, onProgress) => planPartZip(plan, partIndex, pcloudFetch, dir, onProgress)

/** Baixa e envia: arquivo (vídeo inteligente/documento) ou pasta (.zip em partes). */
export async function pcloudSend(io, link, caption = '') {
    const r = await pcloudPlan(link)
    if (r.kind === 'file') {
        const f = await pcloudFetch(r.item, defaultTmp(), 1900 * 1024 * 1024)
        return sendDownloadedFile(io, f, caption)
    }
    return sendPlanAsZips(io, r.plan, pcloudFetch, caption)
}
