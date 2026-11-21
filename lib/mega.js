import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { File } from 'megajs'
import { finishPlan, planPartZip, sendPlanAsZips, FOLDER_MAX_FILES } from './folderzip.js'

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


// ───────────── Pastas ─────────────

export const isMegaFolder = link => /mega\.nz\/(folder\/|#F!)/i.test(String(link))

/** Lista a pasta do MEGA (com subpastas) e devolve o plano SEM baixar nada. */
export async function megaPlanFolder(link) {
    const root = File.fromURL(link)
    await root.loadAttributes()
    if (!root.directory) throw new Error('Esse link não é de uma pasta do MEGA.')
    const items = []
    const walk = (node, prefix) => {
        for (const c of node.children || []) {
            if (c.directory) walk(c, `${prefix}${String(c.name).replace(/[\\/:*?"<>|]/g, '_')}/`)
            else items.push({ name: c.name, path: prefix, size: c.size || 0, node: c })
        }
    }
    walk(root, '')
    if (!items.length) throw new Error('A pasta está vazia.')
    if (items.length > FOLDER_MAX_FILES) throw new Error(`Pasta com mais de ${FOLDER_MAX_FILES} arquivos.`)
    return finishPlan({ name: root.name || 'pasta', items })
}

async function megaFetch(item, dir) {
    const safe = String(item.name || 'arquivo').replace(/[\\/:*?"<>|]/g, '_')
    const out = path.join(dir, `mega_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safe}`)
    await pipeline(item.node.download(), fs.createWriteStream(out))
    return { filePath: out, name: item.name, size: fs.statSync(out).size }
}

export const megaFolderPartZip = (plan, partIndex = 0, dir, onProgress) => planPartZip(plan, partIndex, megaFetch, dir, onProgress)

/** Baixa a pasta do MEGA e envia em um ou mais .zip. */
export async function megaFolderSend(conn, m, link, caption = '') {
    const plan = await megaPlanFolder(link)
    return sendPlanAsZips(conn, m, plan, megaFetch, caption)
}
