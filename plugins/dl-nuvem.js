import { findCloudLink, cloudSend } from '../lib/cloudlinks.js'
import { senaIO } from '../lib/cloudio.js'

// Comando manual para qualquer link suportado (arquivo ou pasta), mesmo com o download automático desligado.
let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) throw `✳️ Mande o link.\n\n📌 Funciona com: Google Drive, MEGA, MediaFire, Dropbox, Yandex Disk, pCloud, GitHub e npm (arquivo ou pasta; pastas vão em .zip).\n\nExemplo: *${usedPrefix + command}* https://www.mediafire.com/folder/...`
    const hit = findCloudLink(text)
    if (!hit) throw `❎ Não reconheci esse link.\n\nSuportados: Google Drive, MEGA, MediaFire, Dropbox, Yandex Disk, pCloud, GitHub e npm.`
    m.react(rwait)
    try {
        await cloudSend(senaIO(conn, m), hit)
        m.react(done)
    } catch (e) {
        console.error(`[nuvem] ${hit.label}:`, e)
        m.react('❌')
        m.reply(`❎ Erro ao baixar do ${hit.label}: ${e.message}`)
    }
}
handler.help = ['nuvem <link>', 'pasta <link>']
handler.tags = ['dl']
handler.command = ['nuvem', 'pasta', 'cloud', 'dlpasta']

export default handler
