import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { File } from 'megajs'

// Download do MEGA direto para o disco (não carrega o arquivo inteiro na memória).
export async function megaDownload(link, dir = path.join(process.cwd(), 'tmp')) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = File.fromURL(link)
    await file.loadAttributes()
    if (file.directory) throw new Error('Esse link é de uma pasta do MEGA; envie o link de um arquivo.')
    if (file.size > 1900 * 1024 * 1024) throw new Error(`Arquivo de ${(file.size / 1048576).toFixed(0)} MB passa do limite de 2 GB do WhatsApp.`)
    const safeName = String(file.name || 'arquivo').replace(/[\\/:*?"<>|]/g, '_')
    const out = path.join(dir, `mega_${Date.now()}_${safeName}`)
    await pipeline(file.download(), fs.createWriteStream(out))
    return { filePath: out, name: file.name || 'arquivo', size: fs.statSync(out).size }
}

export default megaDownload

/** Baixa e envia: vídeos pelo sendVideoSmart (vídeo/documento), o resto como documento. */
export async function megaSend(conn, m, link, caption = '') {
    const mime = (await import('mime-types')).default
    const { sendVideoSmart } = await import('./sendVideo.js')
    const r = await megaDownload(link)
    try {
        const type = mime.lookup(r.name) || 'application/octet-stream'
        const cap = `${caption}${caption ? '\n' : ''}📌 *Nome:* ${r.name}\n⚖️ *Tamanho:* ${(r.size / 1048576).toFixed(1)} MB`
        if (/^video\//.test(type)) {
            await sendVideoSmart(conn, m.chat, r.filePath, r.name, cap, m)
        } else {
            await conn.sendMessage(m.chat, { document: { url: r.filePath }, mimetype: type, fileName: r.name, caption: cap }, { quoted: m })
        }
    } finally {
        try { fs.unlinkSync(r.filePath) } catch (_) {}
    }
}
