import { githubSend } from '../lib/github.js'
import { senaIO } from '../lib/cloudio.js'

// Repositório inteiro (zip), branch/tag, subpasta, arquivo (/blob/) ou arquivo de release.
let handler = async (m, { conn, args, usedPrefix, command }) => {
    if (!args[0])
        throw `Insira um link do GitHub\n\n📌 Exemplos:\n*${usedPrefix + command}* https://github.com/Gumballznx/senna-bot\n*${usedPrefix + command}* https://github.com/Gumballznx/senna-bot/tree/main/plugins`
    m.react(rwait)
    try {
        await githubSend(senaIO(conn, m), args[0])
        m.react(done)
    } catch (e) {
        console.error('[gitclone] erro:', e)
        m.react('❌')
        m.reply(`❎ Erro ao baixar do GitHub: ${e.message}`)
    }
}
handler.help = ['gitclone <url>']
handler.tags = ['dl']
handler.command = ['gitclone']
handler.diamond = true

export default handler
