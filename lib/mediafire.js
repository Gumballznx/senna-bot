import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { finishPlan, planPartZip, sendPlanAsZips, safeName, FOLDER_MAX_FILES } from './folderzip.js'

// MediaFire: arquivo e pasta públicos, direto para o disco (sem carregar na memória).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const API = 'https://www.mediafire.com/api/1.5'

export const mediafireFolderKey = link => (String(link).match(/mediafire\.com\/(?:folder|\?)\/?([a-z0-9]{10,15})/i) || [])[1] || null
export const isMediafireFolder = link => /mediafire\.com\/folder\//i.test(String(link))

/** Do link da página do arquivo para o link direto de download. */
export async function mediafireDirectUrl(pageUrl) {
    const { data: html } = await axios.get(pageUrl, { headers: { 'User-Agent': UA }, timeout: 30000, maxRedirects: 10 })
    const m = String(html).match(/https?:\/\/download\d*\.mediafire\.com\/[^"'\s<>]+/i)
    if (!m) throw new Error('Não achei o link de download (arquivo removido ou protegido por senha).')
    return m[0].replace(/&amp;/g, '&')
}

/** Baixa um arquivo do MediaFire para o disco. */
export async function mediafireDownload(pageUrl, dir = path.join(process.cwd(), 'tmp'), maxBytes = 1900 * 1024 * 1024, nameHint = '') {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const direct = await mediafireDirectUrl(pageUrl)
    const res = await axios.get(direct, { responseType: 'stream', headers: { 'User-Agent': UA }, timeout: 60000, maxRedirects: 10, validateStatus: s => s < 500 })
    if (res.status >= 400 || /text\/html/i.test(String(res.headers['content-type'] || ''))) {
        res.data.destroy()
        throw new Error('O MediaFire recusou o download (link expirado ou arquivo removido).')
    }
    const size = Number(res.headers['content-length']) || 0
    if (size > maxBytes) { res.data.destroy(); throw new Error(`Arquivo de ${(size / 1048576).toFixed(0)} MB passa do limite de 2 GB do WhatsApp.`) }
    let name = nameHint
    if (!name) {
        const cd = String(res.headers['content-disposition'] || '').match(/filename="?([^";]+)"?/i)
        name = cd ? decodeURIComponent(cd[1]) : decodeURIComponent(path.basename(new URL(direct).pathname))
    }
    const out = path.join(dir, `mediafire_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeName(name)}`)
    await pipeline(res.data, fs.createWriteStream(out))
    return { filePath: out, name, size: fs.statSync(out).size }
}

async function apiGet(endpoint, params) {
    const { data } = await axios.get(`${API}/${endpoint}`, { params: { response_format: 'json', ...params }, headers: { 'User-Agent': UA }, timeout: 30000 })
    const r = data?.response
    if (!r || r.result !== 'Success') throw new Error(r?.message || 'O MediaFire não respondeu. A pasta é pública?')
    return r
}

async function listFolder(key, prefix = '', depth = 0, acc = []) {
    if (depth > 6) return acc
    for (const type of ['files', 'folders']) {
        for (let chunk = 1; ; chunk++) {
            const r = await apiGet('folder/get_content.php', { folder_key: key, content_type: type, chunk_size: 100, chunk })
            const c = r.folder_content || {}
            for (const f of c.files || []) {
                acc.push({ name: f.filename, path: prefix, size: Number(f.size) || 0, page: f.links?.normal_download })
            }
            for (const d of c.folders || []) {
                await listFolder(d.folderkey, `${prefix}${safeName(d.name)}/`, depth + 1, acc)
            }
            if (acc.length > FOLDER_MAX_FILES) throw new Error(`Pasta com mais de ${FOLDER_MAX_FILES} arquivos.`)
            if (c.more_chunks !== 'yes') break
        }
    }
    return acc
}

/** Lista a pasta do MediaFire e devolve o plano SEM baixar nada. */
export async function mediafirePlanFolder(link) {
    const key = mediafireFolderKey(link)
    if (!key) throw new Error('Link de pasta do MediaFire inválido.')
    let name = 'pasta'
    try { name = (await apiGet('folder/get_info.php', { folder_key: key })).folder_info?.name || name } catch (_) {}
    const items = await listFolder(key)
    if (!items.length) throw new Error('A pasta está vazia.')
    return finishPlan({ name, items })
}

const mfFetch = (item, dir, maxBytes) => mediafireDownload(item.page, dir, maxBytes, item.name)

export const mediafireFolderPartZip = (plan, partIndex = 0, dir, onProgress) => planPartZip(plan, partIndex, mfFetch, dir, onProgress)

/** Baixa a pasta do MediaFire e envia em um ou mais .zip. */
export async function mediafireFolderSend(conn, m, link, caption = '') {
    const plan = await mediafirePlanFolder(link)
    return sendPlanAsZips(conn, m, plan, mfFetch, caption)
}

/** Baixa e envia um arquivo do MediaFire (vídeo pelo sendVideoSmart; o resto como documento). */
export async function mediafireSend(conn, m, link, caption = '') {
    const mime = (await import('mime-types')).default
    const { sendVideoSmart } = await import('./sendVideo.js')
    const r = await mediafireDownload(link)
    try {
        const type = mime.lookup(r.name) || 'application/octet-stream'
        const cap = `${caption}${caption ? '\n' : ''}📌 *Nome:* ${r.name}\n⚖️ *Tamanho:* ${(r.size / 1048576).toFixed(1)} MB`
        if (/^video\//.test(type)) await sendVideoSmart(conn, m.chat, r.filePath, r.name, cap, m)
        else await conn.sendMessage(m.chat, { document: { url: r.filePath }, mimetype: type, fileName: r.name, caption: cap }, { quoted: m })
    } finally {
        try { fs.unlinkSync(r.filePath) } catch (_) {}
    }
}
