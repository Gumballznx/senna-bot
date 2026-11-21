import { megaSend, megaFolderSend, isMegaFolder } from '../lib/mega.js'

let handler = async (m, { conn, args }) => {
    if (!args[0]) throw `✳️ Insira um link do MEGA`
    m.react(rwait)
    try {
        if (isMegaFolder(args[0])) await megaFolderSend(conn, m, args[0])
        else await megaSend(conn, m, args[0])
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
