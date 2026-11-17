import axios from 'axios'
import crypto from 'crypto'

// Download do YouTube via SaveTube (sem cookies, sem proxy, sem yt-dlp).
// O servidor deles baixa do YouTube, então o IP da VPS não importa.

const BASES = ['https://media.savetube.vip/api', 'https://media.savetube.me/api']
const KEY = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex')
const HEADERS = {
    'content-type': 'application/json',
    origin: 'https://yt.savetube.me',
    referer: 'https://yt.savetube.me/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
}

function decrypt(b64) {
    const buf = Buffer.from(b64, 'base64')
    const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, buf.subarray(0, 16))
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString())
}

export function getYouTubeId(url) {
    const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/)
    return m ? m[1] : null
}

/**
 * @param {string} url  link do YouTube
 * @param {'audio'|'video'} type
 * @param {string} [quality] '128' para áudio; '720' | '480' | '360' para vídeo
 * @returns {Promise<{url:string,title:string,duration:number,thumbnail:string,quality:string}>}
 */
export async function savetube(url, type = 'audio', quality) {
    const id = getYouTubeId(url)
    if (!id) throw new Error('Link do YouTube inválido')
    const ytUrl = `https://www.youtube.com/watch?v=${id}`
    const qualities = type === 'audio' ? [quality || '128'] : [...new Set([quality || '720', '480', '360'])]
    let lastErr
    for (const base of BASES) {
        try {
            const { data: c } = await axios.get(`${base}/random-cdn`, { headers: HEADERS, timeout: 15000 })
            if (!c?.cdn) throw new Error('SaveTube sem CDN')
            const { data: infoRes } = await axios.post(`https://${c.cdn}/v2/info`, { url: ytUrl }, { headers: HEADERS, timeout: 25000 })
            if (!infoRes?.data) throw new Error(infoRes?.message || 'SaveTube sem info')
            const info = decrypt(infoRes.data)
            for (const q of qualities) {
                try {
                    const { data: dl } = await axios.post(`https://${c.cdn}/download`,
                        { downloadType: type, quality: q, key: info.key },
                        { headers: HEADERS, timeout: 90000 })
                    const link = dl?.data?.downloadUrl
                    if (link) {
                        return {
                            url: link,
                            title: info.title || 'YouTube',
                            duration: Number(info.duration) || 0,
                            thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                            quality: q
                        }
                    }
                } catch (e) { lastErr = e }
            }
        } catch (e) { lastErr = e }
    }
    throw new Error(`SaveTube falhou: ${lastErr?.message || 'sem resposta'}`)
}

// Backup independente da chamada acima (usa outra infraestrutura de API).
export async function davidcyril(url, type = 'audio') {
    const ep = type === 'audio' ? 'ytmp3' : 'ytmp4'
    const { data } = await axios.get(`https://apis.davidcyriltech.my.id/download/${ep}`, { params: { url }, timeout: 60000 })
    const r = data?.result
    if (!data?.success || !r?.download_url) throw new Error('davidcyril sem resultado')
    return { url: r.download_url, title: r.title || 'YouTube', duration: 0, thumbnail: r.thumbnail, quality: r.quality }
}

/** Tenta todas as fontes e devolve a primeira que funcionar. */
export async function ytResolve(url, type = 'audio', quality) {
    const errors = []
    for (const fn of [() => savetube(url, type, quality), () => davidcyril(url, type)]) {
        try { return await fn() } catch (e) { errors.push(e.message) }
    }
    throw new Error(errors.join(' | '))
}

export default ytResolve
