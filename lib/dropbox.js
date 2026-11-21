import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { safeName, sendDownloadedFile, mbs, defaultTmp } from './folderzip.js'

// Dropbox: arquivo ou pasta compartilhados (link público). Com dl=1 o Dropbox entrega o arquivo direto,
// e para pasta já entrega um .zip pronto, então não precisamos remontar.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const LIMIT = 1800 * 1024 * 1024

export const isDropboxFolder = link => /dropbox\.com\/(scl\/fo\/|sh\/)/i.test(String(link))

function directUrl(link) {
    const u = new URL(String(link).replace(/[)>\],.]+$/, ''))
    u.searchParams.delete('dl'); u.searchParams.delete('raw')
    u.searchParams.set('dl', '1')
    if (u.hostname === 'dropbox.com') u.hostname = 'www.dropbox.com'
    return u.toString()
}

function filenameFrom(headers, fallback) {
    const cd = String(headers['content-disposition'] || '')
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
    if (star) { try { return decodeURIComponent(star[1]) } catch (_) {} }
    const plain = cd.match(/filename="?([^";]+)"?/i)
    return plain ? plain[1] : fallback
}

/** Baixa arquivo (ou a pasta já em zip) do Dropbox para o disco. */
export async function dropboxDownload(link, dir = defaultTmp(), maxBytes = LIMIT) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const res = await axios.get(directUrl(link), {
        responseType: 'stream', headers: { 'User-Agent': UA }, timeout: 60000, maxRedirects: 10, validateStatus: s => s < 500
    })
    const type = String(res.headers['content-type'] || '')
    if (res.status >= 400 || /text\/html/i.test(type)) {
        res.data.destroy()
        throw new Error('Não consegui baixar: o link do Dropbox não é público, expirou ou foi removido.')
    }
    const declared = Number(res.headers['content-length']) || 0
    if (declared > maxBytes) { res.data.destroy(); throw new Error(`Arquivo de ${mbs(declared)} MB passa do limite de 1,8 GB por arquivo do WhatsApp.`) }
    const folder = isDropboxFolder(link)
    let name = filenameFrom(res.headers, folder ? 'pasta.zip' : 'arquivo')
    if (folder && !/\.zip$/i.test(name)) name += '.zip'
    const out = path.join(dir, `dropbox_${Date.now()}_${safeName(name)}`)
    let received = 0
    res.data.on('data', c => { received += c.length; if (received > maxBytes) res.data.destroy(new Error(`Passou de 1,8 GB (limite por arquivo do WhatsApp). Mande o link de uma subpasta ou de arquivos separados.`)) })
    try {
        await pipeline(res.data, fs.createWriteStream(out))
    } catch (e) {
        try { fs.unlinkSync(out) } catch (_) {}
        throw e
    }
    return { filePath: out, name, size: fs.statSync(out).size, folder }
}

/** Baixa e envia: arquivo (vídeo inteligente/documento) ou pasta (.zip). */
export async function dropboxSend(io, link, caption = '') {
    const folder = isDropboxFolder(link)
    if (folder) await io.text('📁 Baixando a pasta do Dropbox (ele monta o .zip)... pode levar alguns minutos.')
    const r = await dropboxDownload(link)
    if (r.folder) {
        try {
            const cap = `${caption}${caption ? '\n' : ''}📁 *${r.name}*\n⚖️ ${mbs(r.size)} MB`
            await io.document({ filePath: r.filePath, mimetype: 'application/zip', fileName: r.name, caption: cap })
        } finally { try { fs.unlinkSync(r.filePath) } catch (_) {} }
    } else {
        await sendDownloadedFile(io, { filePath: r.filePath, name: r.name, size: r.size }, caption)
    }
}
