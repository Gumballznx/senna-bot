import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { pipeline } from 'stream/promises'
import { safeName, mbs, defaultTmp } from './folderzip.js'

// npm: link do pacote (npmjs.com/package/nome) → baixa o .tgz oficial do registro.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** { name, version } a partir de um link npmjs.com/package/... ou de um nome simples. */
export function npmParse(input) {
    const s = String(input).trim()
    const m = s.match(/npmjs\.com\/package\/((?:@[\w.-]+\/)?[\w.-]+)(?:\/v\/([\w.+-]+))?/i)
    if (m) return { name: m[1], version: m[2] || 'latest' }
    const n = s.match(/^((?:@[\w.-]+\/)?[\w.-]+)(?:@([\w.+-]+))?$/)
    return n ? { name: n[1], version: n[2] || 'latest' } : null
}

export async function npmInfo(name, version = 'latest') {
    const enc = name.startsWith('@') ? name.replace('/', '%2F') : name
    const { data } = await axios.get(`https://registry.npmjs.org/${enc}/${version}`, { headers: { 'User-Agent': UA }, timeout: 20000, validateStatus: s => s < 500 })
    if (!data || data.error || !data.dist?.tarball) throw new Error(`Pacote "${name}"${version !== 'latest' ? '@' + version : ''} não encontrado no npm.`)
    return data
}

/** Baixa o .tgz do pacote e envia com um resumo. */
export async function npmSend(io, input, caption = '') {
    const p = npmParse(input)
    if (!p) throw new Error('Pacote npm inválido.')
    const info = await npmInfo(p.name, p.version)
    const dir = defaultTmp()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const res = await axios.get(info.dist.tarball, { responseType: 'stream', headers: { 'User-Agent': UA }, timeout: 60000 })
    const fileName = `${safeName(p.name.replace('/', '-'))}-${info.version}.tgz`
    const out = path.join(dir, `npm_${Date.now()}_${fileName}`)
    await pipeline(res.data, fs.createWriteStream(out))
    try {
        const size = fs.statSync(out).size
        const cap = `${caption}${caption ? '\n' : ''}📦 *${info.name}* v${info.version}\n${info.description ? `📝 ${info.description}\n` : ''}⚖️ ${mbs(size)} MB${info.license ? ` · 📜 ${typeof info.license === 'string' ? info.license : info.license.type}` : ''}\n🔗 https://www.npmjs.com/package/${info.name}`
        await io.document({ filePath: out, mimetype: 'application/gzip', fileName, caption: cap })
    } finally { try { fs.unlinkSync(out) } catch (_) {} }
}
