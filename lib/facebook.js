import axios from 'axios'

// Download do Facebook sem login. Links /share/r/, /share/v/, fb.watch etc.
// O Facebook bloqueia acesso de servidor (pede login), então usamos uma API externa
// e, como reserva, o link "real" do reel/vídeo para o yt-dlp.

/** Converte links curtos (/share/r/..., fb.watch) no link real do vídeo/reel. */
export async function resolveFacebookUrl(link) {
    if (!/\/share\/|fb\.watch|fb\.com/i.test(link)) return link
    try {
        const res = await axios.get(link, {
            headers: { 'User-Agent': 'facebookexternalhit/1.1' },
            maxRedirects: 10,
            timeout: 15000,
            validateStatus: s => s < 500
        })
        const finalUrl = res.request?.res?.responseUrl || ''
        if (/facebook\.com\/(reel|watch|videos|[^/]+\/videos)\b/.test(finalUrl)) return finalUrl.split('&share_url')[0]
    } catch (_) {}
    return link
}

/**
 * Retorna { title, hd, sd } com links diretos (mp4). hd pode vir vazio.
 */
export async function facebookDownload(link) {
    const errors = []
    const tries = [
        async () => {
            const { data } = await axios.get('https://apis.davidcyriltech.my.id/facebook', { params: { url: link }, timeout: 45000 })
            const d = data?.result?.downloads
            if (!d?.hd?.url && !d?.sd?.url) throw new Error('sem links')
            return { title: (data.result.title || 'Facebook').split('\n')[0].trim(), hd: d.hd?.url || null, sd: d.sd?.url || null }
        },
        async () => {
            const real = await resolveFacebookUrl(link)
            const { data } = await axios.get('https://apis.davidcyriltech.my.id/facebook2', { params: { url: real }, timeout: 45000 })
            const v = data?.video
            const hd = v?.downloads?.find?.(x => /hd|720|1080/i.test(x.quality))?.downloadUrl || v?.hd || null
            const sd = v?.downloads?.find?.(x => /sd|360|480/i.test(x.quality))?.downloadUrl || v?.sd || null
            if (!hd && !sd) throw new Error('sem links')
            return { title: v?.title || 'Facebook', hd, sd }
        }
    ]
    for (const fn of tries) {
        try { return await fn() } catch (e) { errors.push(e.message) }
    }
    throw new Error('Facebook: ' + errors.join(' | '))
}

export default facebookDownload

/**
 * Baixa o vídeo do Facebook para `outPath` (API externa primeiro, yt-dlp como reserva).
 * Retorna true se o arquivo foi gravado.
 */
export async function downloadFacebookToFile(link, outPath) {
    const fs = (await import('fs')).default
    const { pipeline } = await import('stream/promises')
    try {
        const fb = await facebookDownload(link)
        for (const u of [fb.hd, fb.sd].filter(Boolean)) {
            try {
                const resp = await axios.get(u, { responseType: 'stream', timeout: 180000, maxRedirects: 10 })
                await pipeline(resp.data, fs.createWriteStream(outPath))
                if (fs.statSync(outPath).size > 10000) return true
            } catch (_) {}
            try { fs.unlinkSync(outPath) } catch (_) {}
        }
    } catch (e) {
        console.warn('[Facebook] API falhou, tentando yt-dlp:', e.message)
    }
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const realLink = await resolveFacebookUrl(link)
    await promisify(exec)(`yt-dlp -f "b[vcodec^=avc]/b[vcodec^=h264]/hd/sd/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4 -o "${outPath}" "${realLink.replace(/"/g, '')}"`, { timeout: 120000 })
    return fs.existsSync(outPath)
}
