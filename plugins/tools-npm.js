import { npmSend } from '../lib/npmpkg.js'
import { senaIO } from '../lib/cloudio.js'

// .npm <pacote ou link npmjs.com>: manda o .tgz oficial do pacote com um resumo.
let handler = async (m, { conn, text }) => {
  if (!text) throw '✳️ Insira o nome de um pacote (ex.: axios, @whiskeysockets/baileys ou axios@1.7.0) ou o link do npmjs.com'
  m.react(rwait)
  try {
    await npmSend(senaIO(conn, m), text.trim())
    m.react(done)
  } catch (err) {
    m.react('❌')
    m.reply(`✳️ Erro: ${err.message}`)
  }
}

handler.help = ['npm <pacote>']
handler.tags = ['tools']
handler.command = ['npm', 'npmdl', 'npmsearch']

export default handler
