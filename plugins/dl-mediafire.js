import { mediafireSend, mediafireFolderSend, isMediafireFolder } from '../lib/mediafire.js'

let handler = async (m, { conn, args }) => {
  if (!args[0]) throw '✳️ Insira link do Mediafire (arquivo ou pasta)'
  if (!args[0].match(/mediafire/gi)) throw '❎ Insira link do Mediafire'
  m.react(rwait)
  try {
    if (isMediafireFolder(args[0])) await mediafireFolderSend(conn, m, args[0])
    else await mediafireSend(conn, m, args[0])
    m.react(done)
  } catch (e) {
    console.error('[mediafire] erro:', e)
    m.react('❌')
    m.reply(`❎ Erro ao baixar do Mediafire: ${e.message}`)
  }
}
handler.help = ['mediafire <url>']
handler.tags = ['dl', 'prem']
handler.command = ['mediafire', 'mfire']
handler.diamond = true
handler.premium = false

export default handler
