import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'

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

const FOLDER_LIMITS = { files: 300, bytes: 1900 * 1024 * 1024 }

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

const PART_LIMIT = 1800 * 1024 * 1024        // cada .zip fica abaixo do limite de 2 GB do WhatsApp
const FOLDER_TOTAL_LIMIT = 6 * 1024 * 1024 * 1024 // teto da pasta inteira (disco/tempo da VPS)

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

/** Agrupa arquivos em partes de até PART_LIMIT (um arquivo maior que isso fica de fora). */
function splitParts(items) {
    const parts = []; const skipped = []
    let cur = { items: [], bytes: 0 }
    for (const it of items) {
        if (it.size > PART_LIMIT) { skipped.push(it); continue }
        if (cur.bytes + it.size > PART_LIMIT && cur.items.length) { parts.push(cur); cur = { items: [], bytes: 0 } }
        cur.items.push(it); cur.bytes += it.size
    }
    if (cur.items.length) parts.push(cur)
    return { parts, skipped }
}

/** Lista a pasta e mede cada arquivo: devolve { name, items, parts, skipped, total } SEM baixar nada. */
export async function drivePlanFolder(link) {
    const id = driveFolderId(link)
    if (!id) throw new Error('Link de pasta do Google Drive inválido.')
    const list = await listFolder(id)
    if (!list.length) throw new Error('A pasta está vazia ou não é pública.')
    if (list.length > FOLDER_LIMITS.files) throw new Error(`Pasta com mais de ${FOLDER_LIMITS.files} arquivos.`)
    const name = String(list.title || 'pasta').replace(/[\\/:*?"<>|]/g, '_').trim() || 'pasta'
    const items = []
    const unsupported = []
    // mede 6 arquivos por vez
    for (let i = 0; i < list.length; i += 6) {
        await Promise.all(list.slice(i, i + 6).map(async f => {
            if (f.gdoc) { unsupported.push(`${f.name} (arquivo do Google ${f.gdoc})`); return }
            items.push({ ...f, size: await driveFileSize(f.id) })
        }))
    }
    items.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
    const total = items.reduce((n, x) => n + x.size, 0)
    const { parts, skipped } = splitParts(items)
    return { id, name, items, parts, skipped, unsupported, total }
}

async function buildZip(items, zipPath, tmpDir, onProgress) {
    const mod = await import('archiver')
    // v7: archiver('zip', opts) · v8: new ZipArchive(opts)
    const zip = typeof mod.default === 'function' ? mod.default('zip', { zlib: { level: 1 } }) : new mod.ZipArchive({ zlib: { level: 1 } })
    const out = fs.createWriteStream(zipPath)
    const closed = new Promise((resolve, reject) => { out.on('close', resolve); zip.on('error', reject); out.on('error', reject) })
    zip.pipe(out)
    const failed = []; const used = new Set(); let ok = 0
    try {
        for (const [i, f] of items.entries()) {
            try {
                const r = await driveDownload(`https://drive.google.com/file/d/${f.id}/view`, tmpDir, PART_LIMIT)
                let entry = `${f.path}${String(r.name).replace(/[\\/:*?"<>|]/g, '_')}`
                while (used.has(entry)) entry = entry.replace(/(\.[^./]*)?$/, `_${i}$1`)
                used.add(entry)
                zip.file(r.filePath, { name: entry })
                ok++
                if (onProgress) onProgress(ok, items.length)
            } catch (e) { failed.push(`${f.name} (${e.message})`) }
        }
        if (!ok) throw new Error('Não consegui baixar nenhum arquivo.')
        await zip.finalize()
        await closed
    } catch (e) {
        try { zip.abort() } catch (_) {}
        try { fs.unlinkSync(zipPath) } catch (_) {}
        throw e
    }
    return { ok, failed }
}

/**
 * Baixa UMA parte do plano e monta o .zip no disco. Retorna { filePath, name, size, files, failed }.
 */
export async function driveFolderPartZip(plan, partIndex = 0, dir = path.join(process.cwd(), 'tmp'), onProgress = null) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const part = plan.parts[partIndex]
    const suffix = plan.parts.length > 1 ? `_parte${partIndex + 1}de${plan.parts.length}` : ''
    const zipPath = path.join(dir, `gdrive_${Date.now()}_${plan.name}${suffix}.zip`)
    const tmpDir = path.join(dir, `gdrive_folder_${Date.now()}_${partIndex}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
        const { ok, failed } = await buildZip(part.items, zipPath, tmpDir, onProgress)
        return { filePath: zipPath, name: `${plan.name}${suffix}.zip`, size: fs.statSync(zipPath).size, files: ok, total: part.items.length, failed }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
}

/** Compatível com uso simples: baixa a pasta (só a 1ª parte se for grande) num .zip. */
export async function driveFolderZip(link, dir, onProgress) {
    const plan = await drivePlanFolder(link)
    if (!plan.parts.length) throw new Error('Nenhum arquivo da pasta cabe em um zip de até 1,8 GB.')
    return driveFolderPartZip(plan, 0, dir, onProgress)
}

const mbs = b => (b / 1048576).toFixed(b >= 1048576 * 100 ? 0 : 1)

/** Baixa a pasta e envia em um ou mais .zip (cada um abaixo de 2 GB), avisando o que ficou de fora. */
export async function driveFolderSend(conn, m, link, caption = '') {
    const plan = await drivePlanFolder(link)
    const sendable = plan.parts.reduce((n, p) => n + p.bytes, 0)
    if (!plan.parts.length) {
        throw new Error(`Nenhum arquivo dessa pasta cabe no WhatsApp (limite de 2 GB por arquivo). Maior arquivo: ${mbs(Math.max(...plan.items.map(i => i.size)))} MB.`)
    }
    if (sendable > FOLDER_TOTAL_LIMIT) {
        throw new Error(`Pasta muito grande (${mbs(sendable)} MB). O limite é ${mbs(FOLDER_TOTAL_LIMIT)} MB por pasta.`)
    }
    // Aviso antes de começar: pastas grandes demoram
    let resumo = `📁 *${plan.name}*\n📄 ${plan.items.length} arquivos · ⚖️ ${mbs(plan.total)} MB`
    if (plan.parts.length > 1) resumo += `\n📦 Vai em *${plan.parts.length} arquivos .zip* (o WhatsApp aceita até 2 GB por arquivo)`
    if (sendable > 300 * 1024 * 1024) resumo += `\n⏳ Pode levar alguns minutos...`
    await conn.sendMessage(m.chat, { text: resumo }, { quoted: m })

    const notSent = [...plan.skipped.map(x => `${x.path}${x.name} (${mbs(x.size)} MB, acima de 1,8 GB)`), ...plan.unsupported]
    for (let i = 0; i < plan.parts.length; i++) {
        const r = await driveFolderPartZip(plan, i)
        try {
            let cap = `${caption}${caption ? '\n' : ''}📁 *${r.name}*\n📄 ${r.files}/${r.total} arquivos · ⚖️ ${mbs(r.size)} MB`
            if (plan.parts.length > 1) cap += `\n📦 Parte ${i + 1} de ${plan.parts.length}`
            if (i === plan.parts.length - 1) {
                const problems = [...r.failed, ...notSent]
                if (problems.length) cap += `\n\n⚠️ Não enviados:\n${problems.slice(0, 10).map(x => '• ' + x).join('\n')}${problems.length > 10 ? `\n… e mais ${problems.length - 10}` : ''}`
            }
            await conn.sendMessage(m.chat, { document: { url: r.filePath }, mimetype: 'application/zip', fileName: r.name, caption: cap }, { quoted: m })
        } finally {
            try { fs.unlinkSync(r.filePath) } catch (_) {}
        }
    }
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
