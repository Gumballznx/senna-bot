import { fileTypeFromBuffer } from 'file-type'

const ASUPAN_LA_LIST = 'https://raw.githubusercontent.com/fgmods/fg-team/main/img/asupan-la.json'
const ASUPAN_LIST = 'https://raw.githubusercontent.com/fgmods/fg-team/main/img/asupan.json'
const BROKEN_TOP4TOP_HOST = /^https?:\/\/[acgik]\.top4top\.io\//i
const CACHE_TTL_MS = 60 * 60 * 1000
const MIN_VIDEO_BYTES = 10 * 1024
const MAX_VIDEO_BYTES = 45 * 1024 * 1024
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'

const PINTEREST_QUERIES = [
    'asupan tiktok video',
    'tiktok edits video',
    'short aesthetic video',
    'viral dance video'
]

let listCache = { ts: 0, primary: [], secondary: [] }
const failedUrls = new Set()

function pickShuffled(items, limit) {
    const pool = items.filter(u => u && !failedUrls.has(u))
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    return pool.slice(0, limit)
}

function markFailed(url) {
    if (failedUrls.size > 1000) failedUrls.clear()
    failedUrls.add(url)
}

async function withTimeout(timeoutMs, fn) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fn(controller.signal)
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Baixa um vídeo com timeout para conexão/cabeçalhos e transferência do corpo,
 * validando tamanho e tipo real (MIME de vídeo).
 */
async function downloadVideoBuffer(url, headerTimeoutMs = 4500, bodyTimeoutMs = 12000) {
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), headerTimeoutMs)
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA },
            redirect: 'follow',
            signal: controller.signal
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const contentLength = Number(res.headers.get('content-length') || 0)
        if (contentLength > MAX_VIDEO_BYTES) throw new Error(`Vídeo muito grande (${contentLength} bytes)`)

        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), bodyTimeoutMs)

        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length < MIN_VIDEO_BYTES || buffer.length > MAX_VIDEO_BYTES) {
            throw new Error(`Tamanho inválido (${buffer.length} bytes)`)
        }

        const type = await fileTypeFromBuffer(buffer)
        if (!type || !type.mime.startsWith('video/')) {
            throw new Error(`Tipo inválido: ${type?.mime || 'desconhecido'}`)
        }
        return buffer
    } finally {
        clearTimeout(timer)
    }
}

async function fetchJsonList(url) {
    try {
        return await withTimeout(6000, async (signal) => {
            const res = await fetch(url, { signal })
            if (!res.ok) return []
            const data = await res.json()
            return Array.isArray(data)
                ? data.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && !BROKEN_TOP4TOP_HOST.test(u))
                : []
        })
    } catch {
        return []
    }
}

async function getAsupanLists() {
    if (Date.now() - listCache.ts < CACHE_TTL_MS && (listCache.primary.length || listCache.secondary.length)) {
        return listCache
    }
    const [primary, secondary] = await Promise.all([
        fetchJsonList(ASUPAN_LA_LIST),
        fetchJsonList(ASUPAN_LIST)
    ])
    if (primary.length || secondary.length) {
        listCache = { ts: Date.now(), primary, secondary }
    }
    return listCache
}

/**
 * Sonda até `batchSize` URLs em paralelo via HEAD e devolve a primeira
 * que responder com status 200 e MIME de vídeo dentro do limite de tamanho.
 */
async function pickHealthyUrl(urls, batchSize = 4, timeoutMs = 3000) {
    const candidates = pickShuffled(urls, batchSize)
    if (!candidates.length) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const winner = await Promise.any(candidates.map(async (url) => {
            try {
                const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
                const ct = res.headers.get('content-type') || ''
                const len = Number(res.headers.get('content-length') || 0)
                if (!res.ok || !ct.startsWith('video/') || (len && (len < MIN_VIDEO_BYTES || len > MAX_VIDEO_BYTES))) {
                    throw new Error(`HEAD ${res.status}`)
                }
                return url
            } catch (err) {
                if (!controller.signal.aborted) markFailed(url)
                throw err
            }
        }))
        controller.abort()
        return winner
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

async function fetchFromPool(urls) {
    for (let round = 0; round < 2; round++) {
        const winner = await pickHealthyUrl(urls, 4, 3000)
        if (!winner) continue
        try {
            return await downloadVideoBuffer(winner, 4500, 12000)
        } catch {
            markFailed(winner)
        }
    }
    return null
}

async function tryUrls(urls, maxTries) {
    for (const url of pickShuffled(urls, maxTries)) {
        try {
            return await downloadVideoBuffer(url, 4500, 12000)
        } catch {
            markFailed(url)
        }
    }
    return null
}

async function fetchFromTikwm() {
    try {
        const urls = await withTimeout(6000, async (signal) => {
            const res = await fetch('https://www.tikwm.com/api/feed/list?region=BR&count=15', {
                headers: { 'User-Agent': UA },
                signal
            })
            if (!res.ok) return []
            const json = await res.json()
            return (json?.data || [])
                .filter(v => v?.play && (!v.duration || v.duration <= 60))
                .map(v => v.play)
        })
        return await tryUrls(urls, 2)
    } catch {
        return null
    }
}

async function fetchFromPinterest() {
    const query = PINTEREST_QUERIES[Math.floor(Math.random() * PINTEREST_QUERIES.length)]
    try {
        const candidates = await withTimeout(6000, async (signal) => {
            const res = await fetch(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, {
                headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
                signal
            })
            if (!res.ok) return []
            const html = await res.text()
            const matches = [...new Set(html.match(/https:\/\/v1\.pinimg\.com\/videos\/[^\s"'<>]+\.mp4/gi) || [])]
            const hq = matches.filter(u => u.includes('720p') || u.includes('720w'))
            return hq.length ? hq : matches
        })
        return await tryUrls(candidates, 2)
    } catch {
        return null
    }
}

/**
 * Tenta obter um vídeo curto aleatório em ordem de prioridade:
 * 1) listas oficiais do fg-team no GitHub (sondando hosts saudáveis em paralelo)
 * 2) feed público do TikWM
 * 3) vídeos curtos do Pinterest
 */
async function fetchRandomVideo() {
    const lists = await getAsupanLists()
    const providers = [
        () => fetchFromPool(lists.primary),
        () => fetchFromPool(lists.secondary),
        fetchFromTikwm,
        fetchFromPinterest
    ]
    for (const getVideo of providers) {
        const buffer = await getVideo()
        if (buffer) return buffer
    }
    throw new Error('Nenhuma fonte de vídeo respondeu a tempo')
}

let handler = async (m, { conn }) => {
    m.react(global.rwait || '⌛')
    try {
        const asupan = await fetchRandomVideo()
        await conn.sendFile(m.chat, asupan, 'vid.mp4', `✅ Resultado`, m, null, global.fwc || {})
        m.react('🤓')
    } catch (err) {
        m.error = err
        console.error('[img-asupan] erro:', err?.message || err)
        m.react('❌')
        await m.reply('❌ Não foi possível obter um vídeo no momento. Tente novamente em instantes.')
    }
}

handler.help = ['video', 'asupan']
handler.tags = ['img']
handler.command = ['asupan', 'tvid', 'videos', 'vid', 'video']
handler.premium = false
handler.diamond = true

export default handler
