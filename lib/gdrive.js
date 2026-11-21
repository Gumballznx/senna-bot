import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { finishPlan, planPartZip, sendPlanAsZips, FOLDER_MAX_FILES } from './folderzip.js'

// Download de arquivo PÚBLICO do Google Drive direto para o disco (sem carregar na memória).
// Usa drive.usercontent.google.com, que entrega o arquivo sem a página de "aviso de vírus".

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export function driveFileId(link) {
    const m = String(link).match(/drive\.google\.com\/file\/d\/([\w-]{15,})/i)
        || String(link).match(/drive\.google\.com\/(?:open|uc)\?(?:[^#\s]*&)?id=([\w-]{15,})/i)
        || String(link).match(/docs\.google\.com\/[a-z]+\/d\/([\w-]{15,})/i)
    return m ? m[1] : null
}

function filenameFrom(headers, fallback) {
    const cd = String(headers['content-disposition'] || '')
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
    if (star) { try { return decodeURIComponent(star[1]) } catch (_) {} }
    const plain = cd.match(/filename="?([^";]+)"?/i)
    return plain ? plain[1] : fallback
}

export async function driveDownload(link, dir = path.join(process.cwd(), 'tmp'), maxBytes = 1900 * 1024 * 1024) {
    const id = driveFileId(link)
    if (!id) throw new Error('Link do Google Drive inválido.')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const res = await axios.get('https://drive.usercontent.google.com/download', {
        params: { id, export: 'download', confirm: 't' },
        responseType: 'stream',
        headers: { 'User-Agent': UA },
        timeout: 60000,
        maxRedirects: 10,
        validateStatus: s => s < 500
    })
    const type = String(res.headers['content-type'] || '')
    if (res.status === 404) throw new Error('Arquivo não encontrado no Google Drive.')
    if (res.status >= 400 || /text\/html/i.test(type)) {
        res.data.destroy()
        throw new Error('Esse arquivo não é público. No Drive, compartilhe como "Qualquer pessoa com o link".')
    }
    const size = Number(res.headers['content-length']) || 0
    if (size > maxBytes) {
        res.data.destroy()
        throw new Error(`Arquivo de ${(size / 1048576).toFixed(0)} MB passa do limite de 2 GB do WhatsApp.`)
    }
    const name = filenameFrom(res.headers, `drive_${id}`)
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_')
    const out = path.join(dir, `gdrive_${Date.now()}_${safe}`)
    await pipeline(res.data, fs.createWriteStream(out))
    return { filePath: out, name, size: fs.statSync(out).size, mimetype: type.split(';')[0] || 'application/octet-stream' }
}

// ───────────── Pastas ─────────────

export function driveFolderId(link) {
    const m = String(link).match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|folderview\?id=|open\?id=)([\w-]{15,})/i)
    return m ? m[1] : null
}

const FOLDER_LIMITS = { files: FOLDER_MAX_FILES }

/** Lista a pasta (e subpastas) pela página embeddedfolderview, que não exige login. */
async function listFolder(id, prefix = '', depth = 0, acc = []) {
    if (depth > 6) return acc
    const { data: html, status } = await axios.get('https://drive.google.com/embeddedfolderview', {
        params: { id }, headers: { 'User-Agent': UA }, timeout: 30000, validateStatus: s => s < 500
    })
    if (status !== 200 || typeof html !== 'string') {
        throw new Error('Não consegui abrir essa pasta. Compartilhe como "Qualquer pessoa com o link".')
    }
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || 'pasta'
    const decode = t => t.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    const seen = new Set()
    const re = /<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    const subfolders = []
    while ((m = re.exec(html))) {
        const href = decode(m[1])
        const label = decode(m[2].replace(/<[^>]*>/g, '')).trim()
        let f = href.match(/drive\.google\.com\/file\/d\/([\w-]{20,})/)
        if (f && !seen.has(f[1])) { seen.add(f[1]); acc.push({ id: f[1], name: label || f[1], path: prefix }); continue }
        const sub = href.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]{20,})/)
        if (sub && !seen.has('d' + sub[1])) { seen.add('d' + sub[1]); subfolders.push({ id: sub[1], name: label || sub[1] }); continue }
        const doc = href.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]{20,})/)
        if (doc && !seen.has(doc[2])) { seen.add(doc[2]); acc.push({ id: doc[2], name: label || doc[2], path: prefix, gdoc: doc[1] }) }
    }
    for (const sf of subfolders) {
        await listFolder(sf.id, `${prefix}${sf.name.replace(/[\\/:*?"<>|]/g, '_')}/`, depth + 1, acc)
        if (acc.length > FOLDER_LIMITS.files) throw new Error(`Pasta com mais de ${FOLDER_LIMITS.files} arquivos.`)
    }
    acc.title = acc.title || decode(title).replace(/\s*-\s*Google Drive$/i, '')
    return acc
}

/** Tamanho de um arquivo do Drive sem baixar (pede só o 1º byte). 0 se não souber. */
async function driveFileSize(id) {
    try {
        const r = await axios.get('https://drive.usercontent.google.com/download', {
            params: { id, export: 'download', confirm: 't' },
            headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
            responseType: 'arraybuffer', timeout: 30000, validateStatus: s => s < 500
        })
        const total = String(r.headers['content-range'] || '').split('/')[1]
        return Number(total) || Number(r.headers['content-length']) || 0
    } catch { return 0 }
}

/** Lista a pasta e mede cada arquivo: devolve o plano SEM baixar nada. */
export async function drivePlanFolder(link) {
    const id = driveFolderId(link)
    if (!id) throw new Error('Link de pasta do Google Drive inválido.')
    const list = await listFolder(id)
    if (!list.length) throw new Error('A pasta está vazia ou não é pública.')
    if (list.length > FOLDER_MAX_FILES) throw new Error(`Pasta com mais de ${FOLDER_MAX_FILES} arquivos.`)
    const items = []; const unsupported = []
    for (let i = 0; i < list.length; i += 6) { // mede 6 arquivos por vez
        await Promise.all(list.slice(i, i + 6).map(async f => {
            if (f.gdoc) { unsupported.push(`${f.name} (arquivo do Google ${f.gdoc})`); return }
            items.push({ ...f, size: await driveFileSize(f.id) })
        }))
    }
    return finishPlan({ name: list.title || 'pasta', items, unsupported })
}

const driveFetch = (f, tmpDir, maxBytes) => driveDownload(`https://drive.google.com/file/d/${f.id}/view`, tmpDir, maxBytes)

export const driveFolderPartZip = (plan, partIndex = 0, dir, onProgress) => planPartZip(plan, partIndex, driveFetch, dir, onProgress)

/** Compatível com uso simples: baixa a pasta (só a 1ª parte se for grande) num .zip. */
export async function driveFolderZip(link, dir, onProgress) {
    const plan = await drivePlanFolder(link)
    if (!plan.parts.length) throw new Error('Nenhum arquivo da pasta cabe em um zip de até 1,8 GB.')
    return driveFolderPartZip(plan, 0, dir, onProgress)
}

/** Baixa a pasta e envia em um ou mais .zip (cada um abaixo de 2 GB), avisando o que ficou de fora. */
export async function driveFolderSend(conn, m, link, caption = '') {
    const plan = await drivePlanFolder(link)
    return sendPlanAsZips(conn, m, plan, driveFetch, caption)
}

/** Baixa e envia: vídeo pelo sendVideoSmart (vídeo/documento); o resto como documento. */
export async function driveSend(conn, m, link, caption = '') {
    const mime = (await import('mime-types')).default
    const { sendVideoSmart } = await import('./sendVideo.js')
    const r = await driveDownload(link)
    try {
        const type = mime.lookup(r.name) || r.mimetype || 'application/octet-stream'
        const cap = `${caption}${caption ? '\n' : ''}📌 *Nome:* ${r.name}\n⚖️ *Tamanho:* ${(r.size / 1048576).toFixed(1)} MB`
        if (/^video\//.test(type)) {
            await sendVideoSmart(conn, m.chat, r.filePath, r.name.replace(/\.(mov|mkv|avi|webm)$/i, '') + '.mp4', cap, m)
        } else {
            await conn.sendMessage(m.chat, { document: { url: r.filePath }, mimetype: type, fileName: r.name, caption: cap }, { quoted: m })
        }
    } finally {
        try { fs.unlinkSync(r.filePath) } catch (_) {}
    }
}

export default driveDownload
