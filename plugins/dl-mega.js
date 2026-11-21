import { megaSend, megaFolderSend, isMegaFolder } from '../lib/mega.js'
import { senaIO } from '../lib/cloudio.js'

let handler = async (m, { conn, args }) => {
    if (!args[0]) throw `✳️ Insira um link do MEGA (arquivo ou pasta)`
    m.react(rwait)
    try {
        const io = senaIO(conn, m)
        if (isMegaFolder(args[0])) await megaFolderSend(io, args[0])
        else await megaSend(io, args[0])
        m.react(done)
    } catch (e) {
        console.error('[mega] erro:', e)
        m.react('❌')
        m.reply(`❎ Erro ao baixar MEGA: ${e.message}`)
    }
}
handler.help = ['mega']
handler.tags = ['dl', 'prem']
handler.command = ['mega', 'megadl']
handler.premium = false

export default handler
