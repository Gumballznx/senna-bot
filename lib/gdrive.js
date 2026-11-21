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
