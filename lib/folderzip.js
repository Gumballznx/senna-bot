import fs from 'fs'
import path from 'path'

// Motor genérico para "baixar uma pasta e mandar em .zip" (Google Drive, MEGA, MediaFire...).
// Cada serviço só precisa montar um PLANO e dizer como baixar um arquivo:
//   plan  = { name, items: [{ name, path, size, ...dadosDoServico }], unsupported: [] }
//   fetch = async (item, tmpDir, maxBytes) => ({ filePath, name, size })

export const PART_LIMIT = 1800 * 1024 * 1024            // cada .zip fica abaixo do limite de 2 GB do WhatsApp
export const FOLDER_TOTAL_LIMIT = 6 * 1024 * 1024 * 1024 // teto da pasta inteira (disco/tempo da VPS)
export const FOLDER_MAX_FILES = 300

export const mbs = b => (b / 1048576).toFixed(b >= 1048576 * 100 ? 0 : 1)
export const safeName = n => String(n || 'arquivo').replace(/[\\/:*?"<>|]/g, '_').trim() || 'arquivo'

/** Agrupa arquivos em partes de até PART_LIMIT (um arquivo maior que isso fica de fora). */
export function splitParts(items) {
    const parts = []; const skipped = []
    let cur = { items: [], bytes: 0 }
    for (const it of items) {
        if (it.size > PART_LIMIT) { skipped.push(it); continue }
        if (cur.bytes + it.size > PART_LIMIT && cur.items.length) { parts.push(cur); cur = { items: [], bytes: 0 } }
        cur.items.push(it); cur.bytes += it.size
    }
    if (cur.items.length) parts.push(cur)
    return { parts, skipped }
}

/** Completa um plano bruto { name, items, unsupported } com total, partes e arquivos de fora. */
export function finishPlan(raw) {
    const items = [...raw.items].sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
    const { parts, skipped } = splitParts(items)
    return { name: safeName(raw.name), items, parts, skipped, unsupported: raw.unsupported || [], total: items.reduce((n, x) => n + (x.size || 0), 0) }
}

async function buildZip(items, zipPath, tmpDir, fetchItem, onProgress) {
    const mod = await import('archiver')
    // v7: archiver('zip', opts) · v8: new ZipArchive(opts)
    const zip = typeof mod.default === 'function' ? mod.default('zip', { zlib: { level: 1 } }) : new mod.ZipArchive({ zlib: { level: 1 } })
    const out = fs.createWriteStream(zipPath)
    const closed = new Promise((resolve, reject) => { out.on('close', resolve); zip.on('error', reject); out.on('error', reject) })
    zip.pipe(out)
    const failed = []; const used = new Set(); let ok = 0
    try {
        for (const [i, f] of items.entries()) {
            try {
                const r = await fetchItem(f, tmpDir, PART_LIMIT)
                let entry = `${f.path}${safeName(r.name)}`
                while (used.has(entry)) entry = entry.replace(/(\.[^./]*)?$/, `_${i}$1`)
                used.add(entry)
                zip.file(r.filePath, { name: entry })
                ok++
                if (onProgress) onProgress(ok, items.length)
            } catch (e) { failed.push(`${f.name} (${e.message})`) }
        }
        if (!ok) throw new Error('Não consegui baixar nenhum arquivo.')
        await zip.finalize()
        await closed
    } catch (e) {
        try { zip.abort() } catch (_) {}
        try { fs.unlinkSync(zipPath) } catch (_) {}
        throw e
    }
    return { ok, failed }
}

/** Baixa UMA parte do plano e monta o .zip no disco. */
export async function planPartZip(plan, partIndex, fetchItem, dir = path.join(process.cwd(), 'tmp'), onProgress = null) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const part = plan.parts[partIndex]
    const suffix = plan.parts.length > 1 ? `_parte${partIndex + 1}de${plan.parts.length}` : ''
    const zipPath = path.join(dir, `pasta_${Date.now()}_${plan.name}${suffix}.zip`)
    const tmpDir = path.join(dir, `pasta_tmp_${Date.now()}_${partIndex}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
        const { ok, failed } = await buildZip(part.items, zipPath, tmpDir, fetchItem, onProgress)
        return { filePath: zipPath, name: `${plan.name}${suffix}.zip`, size: fs.statSync(zipPath).size, files: ok, total: part.items.length, failed }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
}

/** Valida o plano, avisa o usuário, baixa cada parte e envia os .zip. */
export async function sendPlanAsZips(conn, m, plan, fetchItem, caption = '') {
    const sendable = plan.parts.reduce((n, p) => n + p.bytes, 0)
    if (!plan.parts.length) {
        const biggest = plan.items.length ? mbs(Math.max(...plan.items.map(i => i.size))) : '0'
        throw new Error(`Nenhum arquivo dessa pasta cabe no WhatsApp (limite de 2 GB por arquivo). Maior arquivo: ${biggest} MB.`)
    }
    if (sendable > FOLDER_TOTAL_LIMIT) {
        throw new Error(`Pasta muito grande (${mbs(sendable)} MB). O limite é ${mbs(FOLDER_TOTAL_LIMIT)} MB por pasta.`)
    }
    let resumo = `📁 *${plan.name}*\n📄 ${plan.items.length} arquivos · ⚖️ ${mbs(plan.total)} MB`
    if (plan.parts.length > 1) resumo += `\n📦 Vai em *${plan.parts.length} arquivos .zip* (o WhatsApp aceita até 2 GB por arquivo)`
    if (sendable > 300 * 1024 * 1024) resumo += `\n⏳ Pode levar alguns minutos...`
    await conn.sendMessage(m.chat, { text: resumo }, { quoted: m })

    const notSent = [...plan.skipped.map(x => `${x.path}${x.name} (${mbs(x.size)} MB, acima de 1,8 GB)`), ...plan.unsupported]
    for (let i = 0; i < plan.parts.length; i++) {
        const r = await planPartZip(plan, i, fetchItem)
        try {
            let cap = `${caption}${caption ? '\n' : ''}📁 *${r.name}*\n📄 ${r.files}/${r.total} arquivos · ⚖️ ${mbs(r.size)} MB`
            if (plan.parts.length > 1) cap += `\n📦 Parte ${i + 1} de ${plan.parts.length}`
            if (i === plan.parts.length - 1) {
                const problems = [...r.failed, ...notSent]
                if (problems.length) cap += `\n\n⚠️ Não enviados:\n${problems.slice(0, 10).map(x => '• ' + x).join('\n')}${problems.length > 10 ? `\n… e mais ${problems.length - 10}` : ''}`
            }
            await conn.sendMessage(m.chat, { document: { url: r.filePath }, mimetype: 'application/zip', fileName: r.name, caption: cap }, { quoted: m })
        } finally {
            try { fs.unlinkSync(r.filePath) } catch (_) {}
        }
    }
}
