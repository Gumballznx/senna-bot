import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { finishPlan, planPartZip, sendPlanAsZips, sendDownloadedFile, safeName, mbs, FOLDER_MAX_FILES, defaultTmp } from './folderzip.js'

// GitHub: repositório inteiro (zip), branch/tag, SUBPASTA, arquivo (/blob/) e arquivo de release.
// Usa codeload/raw (sem limite de API). A API só entra para listar subpastas e (opcional) para o resumo.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const LIMIT = 1800 * 1024 * 1024
const apiHeaders = () => ({ 'User-Agent': UA, Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) })

/**
 * Interpreta o link. Retorna null para o que NÃO é para baixar (issues, pull requests, actions, wiki...).
 * { owner, repo, kind: 'repo'|'tree'|'blob'|'release', rest }
 */
export function githubParse(link) {
    const m = String(link).match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob|releases\/download)\/([^?#\s]+))?\/?(?:[?#].*)?$/i)
    if (!m) return null
    const [, owner, repo, kind, rest] = m
    if (!kind) return { owner, repo, kind: 'repo', rest: '' }
    if (kind === 'tree') return { owner, repo, kind: 'tree', rest: decodeURIComponent(rest.replace(/\/$/, '')) }
    if (kind === 'blob') return { owner, repo, kind: 'blob', rest: decodeURIComponent(rest) }
    return { owner, repo, kind: 'release', rest: decodeURIComponent(rest) }
}

async function streamToFile(url, dir, fallbackName, maxBytes = LIMIT, headers = {}) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const res = await axios.get(url, { responseType: 'stream', headers: { 'User-Agent': UA, ...headers }, timeout: 60000, maxRedirects: 10, validateStatus: s => s < 500 })
    if (res.status === 404) { res.data.destroy(); throw new Error('Não encontrado (o repositório é privado ou o endereço não existe).') }
    if (res.status >= 400) { res.data.destroy(); throw new Error(`O GitHub recusou (HTTP ${res.status}).`) }
    const declared = Number(res.headers['content-length']) || 0
    if (declared > maxBytes) { res.data.destroy(); throw new Error(`Arquivo de ${mbs(declared)} MB passa do limite de 1,8 GB do WhatsApp.`) }
    const cd = String(res.headers['content-disposition'] || '').match(/filename="?([^";]+)"?/i)
    const name = cd ? decodeURIComponent(cd[1]) : fallbackName
    const out = path.join(dir, `github_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeName(name)}`)
    let received = 0
    res.data.on('data', c => { received += c.length; if (received > maxBytes) res.data.destroy(new Error('Passou de 1,8 GB (limite do WhatsApp).')) })
    try { await pipeline(res.data, fs.createWriteStream(out)) } catch (e) { try { fs.unlinkSync(out) } catch (_) {}; throw e }
    return { filePath: out, name, size: fs.statSync(out).size }
}

/** Descobre onde termina o nome da branch e começa o caminho (branches podem ter "/"). */
async function resolveRef(owner, repo, rest) {
    const parts = rest.split('/')
    for (let n = parts.length; n >= 1; n--) {
        const ref = parts.slice(0, n).join('/')
        const r = await axios.head(`https://codeload.github.com/${owner}/${repo}/zip/${ref}`, { headers: { 'User-Agent': UA }, timeout: 20000, validateStatus: () => true }).catch(() => null)
        if (r && r.status === 200) return { ref, sub: parts.slice(n).join('/') }
    }
    return null
}

async function listSubfolder(owner, repo, ref, sub) {
    const { data } = await axios.get(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`, { params: { recursive: 1 }, headers: apiHeaders(), timeout: 30000 })
    if (data.truncated) throw new Error('Repositório grande demais para listar a subpasta. Baixe o repositório inteiro.')
    const prefix = sub ? sub.replace(/\/$/, '') + '/' : ''
    const items = data.tree.filter(t => t.type === 'blob' && t.path.startsWith(prefix)).map(t => {
        const rel = t.path.slice(prefix.length); const slash = rel.lastIndexOf('/')
        return { name: rel.slice(slash + 1), path: slash >= 0 ? rel.slice(0, slash + 1) : '', size: t.size || 0, full: t.path, owner, repo, ref }
    })
    if (!items.length) throw new Error('Subpasta não encontrada ou vazia.')
    if (items.length > FOLDER_MAX_FILES) throw new Error(`Subpasta com mais de ${FOLDER_MAX_FILES} arquivos.`)
    return items
}

const rawFetch = (item, dir, maxBytes) => streamToFile(`https://raw.githubusercontent.com/${item.owner}/${item.repo}/${encodeURIComponent(item.ref)}/${item.full.split('/').map(encodeURIComponent).join('/')}`, dir, item.name, maxBytes)

rawFetch.concurrency = 8 // muitos arquivos pequenos: baixa 8 por vez

/** Resumo do repositório (estrelas etc.). Falha em silêncio: a API tem limite de consultas. */
async function repoSummary(owner, repo) {
    try {
        const { data } = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers: apiHeaders(), timeout: 10000 })
        return `⭐ ${data.stargazers_count} · 🍴 ${data.forks_count} · 🔄 ${String(data.pushed_at || '').slice(0, 10)}${data.description ? `\n📝 ${data.description}` : ''}`
    } catch { return '' }
}

/** Baixa e envia conforme o tipo do link do GitHub. */
export async function githubSend(io, link, caption = '') {
    const p = githubParse(link)
    if (!p) throw new Error('Link do GitHub não reconhecido.')
    const { owner, repo } = p
    const dir = defaultTmp()

    if (p.kind === 'blob' || p.kind === 'release') {
        const url = p.kind === 'release'
            ? `https://github.com/${owner}/${repo}/releases/download/${p.rest}`
            : `https://github.com/${owner}/${repo}/raw/${p.rest}`
        const f = await streamToFile(url, dir, p.rest.split('/').pop())
        return sendDownloadedFile(io, f, caption)
    }

    // repo inteiro ou branch/tag inteiro
    let ref = 'HEAD', sub = ''
    if (p.kind === 'tree') {
        const r = await resolveRef(owner, repo, p.rest)
        if (!r) throw new Error('Branch, tag ou pasta não encontrada.')
        ;({ ref, sub } = r)
    }
    if (sub) {
        const items = await listSubfolder(owner, repo, ref, sub)
        const plan = finishPlan({ name: `${repo}-${sub.split('/').pop()}`, items })
        return sendPlanAsZips(io, plan, rawFetch, caption)
    }
    const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/${ref === 'HEAD' ? 'HEAD' : ref}`
    const info = p.kind === 'repo' ? await repoSummary(owner, repo) : ''
    const f = await streamToFile(zipUrl, dir, `${repo}.zip`)
    const name = `${owner}-${repo}${ref !== 'HEAD' ? '-' + safeName(ref) : ''}.zip`
    try {
        const cap = `${caption}${caption ? '\n' : ''}📦 *${owner}/${repo}*${ref !== 'HEAD' ? ` (${ref})` : ''}\n⚖️ ${mbs(f.size)} MB${info ? '\n' + info : ''}`
        await io.document({ filePath: f.filePath, mimetype: 'application/zip', fileName: name, caption: cap })
    } finally { try { fs.unlinkSync(f.filePath) } catch (_) {} }
}
