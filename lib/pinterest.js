import axios from 'axios'

// Downloader de links do Pinterest sem depender do Cobalt.
// Usa a API interna (PinResource) e, se falhar, lê o JSON embutido na página do pin.

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'

export async function resolvePinId(link) {
    let url = link.trim()
    let m = url.match(/pinterest\.[a-z.]+\/pin\/(?:[^/?#]*--)?(\d+)/i)
    if (m) return m[1]
    // Links curtos pin.it -> segue redirecionamento
    const res = await axios.get(url, {
        headers: { 'User-Agent': UA },
        maxRedirects: 10,
        timeout: 15000,
        validateStatus: s => s < 500
    })
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || ''
    m = finalUrl.match(/\/pin\/(?:[^/?#]*--)?(\d+)/) || String(res.data || '').match(/pinterest\.[a-z.]+\/pin\/(\d+)/)
    if (!m) throw new Error('Não consegui identificar o pin nesse link.')
    return m[1]
}

function pickVideo(obj) {
    const lists = []
    const walk = o => {
        if (!o || typeof o !== 'object') return
        if (o.video_list && typeof o.video_list === 'object') lists.push(o.video_list)
        for (const k in o) walk(o[k])
    }
    walk(obj)
    const order = ['V_720P', 'V_EXP7', 'V_EXP6', 'V_EXP5', 'V_EXP4', 'V_EXP3', 'V_540P', 'V_480P', 'V_360P', 'V_240P']
    for (const vl of lists) {
        for (const q of order) if (vl[q]?.url?.endsWith('.mp4')) return vl[q].url
        for (const k in vl) if (vl[k]?.url?.endsWith('.mp4')) return vl[k].url
    }
    return null
}

function pickImages(data) {
    const out = []
    const pages = data?.story_pin_data?.pages
    if (Array.isArray(pages)) {
        for (const p of pages) for (const b of p.blocks || []) {
            const u = b?.image?.images?.originals?.url || b?.image?.images?.['736x']?.url
            if (u) out.push(u)
        }
    }
    const carousel = data?.carousel_data?.carousel_slots
    if (Array.isArray(carousel)) {
        for (const c of carousel) {
            const u = c?.images?.orig?.url || c?.images?.['736x']?.url
            if (u) out.push(u)
        }
    }
    if (!out.length) {
        const u = data?.images?.orig?.url || data?.images?.['736x']?.url
        if (u) out.push(u)
    }
    return [...new Set(out)]
}

async function fromApi(id) {
    const { data } = await axios.get('https://www.pinterest.com/resource/PinResource/get/', {
        params: { data: JSON.stringify({ options: { id, field_set_key: 'detailed' } }) },
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'X-Pinterest-PWS-Handler': 'www/pin/[id].js'
        },
        timeout: 15000
    })
    const pin = data?.resource_response?.data
    if (!pin) throw new Error('API sem dados')
    return pin
}

async function fromPage(id) {
    const { data: html } = await axios.get(`https://www.pinterest.com/pin/${id}/`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
        timeout: 15000
    })
    const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g
    let m, found = null
    while ((m = re.exec(html))) {
        try {
            const j = JSON.parse(m[1])
            const walk = o => {
                if (found || !o || typeof o !== 'object') return
                if (String(o.id) === String(id) && (o.images || o.videos || o.story_pin_data)) { found = o; return }
                for (const k in o) walk(o[k])
            }
            walk(j)
        } catch {}
        if (found) break
    }
    if (found) return found
    const og = html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:image"/)
    if (og) return { images: { orig: { url: og[1] } } }
    throw new Error('Página do pin sem mídia')
}

/**
 * Retorna { type: 'video', url, title } ou { type: 'image', urls: [...], title }
 */
export async function pinterestDownload(link) {
    const id = await resolvePinId(link)
    let pin
    try { pin = await fromApi(id) } catch { pin = await fromPage(id) }
    const title = pin.grid_title || pin.title || pin.description || 'Pinterest'
    const video = pickVideo(pin)
    if (video) return { type: 'video', url: video, title, id }
    const urls = pickImages(pin)
    if (urls.length) return { type: 'image', urls, title, id }
    throw new Error('Esse pin não tem mídia para baixar.')
}

export default pinterestDownload
