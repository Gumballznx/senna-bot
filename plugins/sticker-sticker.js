import { sticker } from '../lib/sticker.js'
import uploadFile from '../lib/uploadFile.js'
import uploadImage from '../lib/uploadImage.js'
import { webp2png } from '../lib/webp2mp4.js'
import { downloadContentFromMessage } from '@whiskeysockets/baileys'

let handler = async (m, { conn, args, usedPrefix, command }) => {
  let stiker = false
  let stick = args.join(" ").split("|");
  let f = stick[0] !== "" ? stick[0] : packname;
  let g = typeof stick[1] !== "undefined" ? stick[1] : author;
  try {
    let q = m.quoted ? m.quoted : m
    let mime = q.mimetype || q.mediaType || (q.msg && q.msg.mimetype) || ''

    if (/webp|image|video/g.test(mime) || q.mediaMessage) {
      let duration = q.msg?.seconds || q.seconds || 0
      if (/video/g.test(mime) && duration > 11) return m.reply('Máximo 10 segundos')

      let img = await Promise.resolve(typeof q.download === 'function' ? q.download() : null).catch((err) => {
        console.error('[STICKER Q.DOWNLOAD FAILED]:', err)
        return null
      })

      if (!img || img.length === 0) {
        let viewOnceMsg = q.msg?.message?.imageMessage ||
                          q.msg?.message?.videoMessage ||
                          q.message?.imageMessage ||
                          q.message?.videoMessage ||
                          (q.msg && (q.msg.imageMessage || q.msg.videoMessage)) ||
                          q.msg || q
        if (viewOnceMsg?.mediaKey) {
          const type = /video/g.test(mime) ? 'video' : 'image'
          try {
            const stream = await downloadContentFromMessage(viewOnceMsg, type)
            let buffer = Buffer.from([])
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk])
            }
            img = buffer
          } catch (e) {
            console.error('downloadContentFromMessage falhou:', e)
          }
        }
      }

      // Última tentativa: a citação de visualização única costuma vir sem a chave da mídia.
      // Busca a mensagem ORIGINAL guardada quando ela chegou ao bot.
      if ((!img || img.length === 0) && m.quoted) {
        try {
          const qid = m.quoted.id || m.msg?.contextInfo?.stanzaId
          const raw = qid ? await conn.loadMessage?.(m.chat, qid) : null
          const mm = raw?.message || {}
          const inner = mm.viewOnceMessageV2?.message || mm.viewOnceMessageV2Extension?.message || mm.viewOnceMessage?.message || mm
          const media = inner?.imageMessage || inner?.videoMessage
          if (media?.mediaKey && media.mediaKey.length) {
            const stream = await downloadContentFromMessage(media, inner.videoMessage ? 'video' : 'image')
            let buffer = Buffer.from([])
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk])
            img = buffer
          }
        } catch (e) {
          console.error('[STICKER] busca da mensagem original falhou:', e?.message || e)
        }
      }

      const isViewOnceQuote = !!(m.msg?.contextInfo?.quotedMessage && JSON.stringify(Object.keys(m.msg.contextInfo.quotedMessage)).match(/viewOnce/) || q.msg?.viewOnce || q.viewOnce)
      if ((!img || img.length === 0) && isViewOnceQuote) {
        throw `⚠️ Essa é uma mídia de *visualização única* e o WhatsApp não entregou o conteúdo dela para o bot.\n\nPeça para reenviar a mídia normalmente (sem visualização única) e use *${usedPrefix + command}*.`
      }
      if (!img || img.length === 0) throw `✳️ Responda a uma imagem ou vídeo com *${usedPrefix + command}*`

      let out
      try {
        stiker = await sticker(img, false, f, g)
      } catch (e) {
        console.error(e)
      } finally {
        if (!stiker) {
          if (/webp/g.test(mime)) out = await webp2png(img)
          else if (/image/g.test(mime)) out = await uploadImage(img)
          else if (/video/g.test(mime)) out = await uploadFile(img)
          if (typeof out !== 'string') out = await uploadImage(img)
          stiker = await sticker(false, out, f, g)
        }
      }
    } else if (args[0]) {
      if (isUrl(args[0])) stiker = await sticker(false, args[0], global.packname, global.author)
      else return m.reply('URL inválida')
    }
  } catch (e) {
    console.error(e)
    if (!stiker) stiker = e
  } finally {
    if (stiker && Buffer.isBuffer(stiker)) conn.sendFile(m.chat, stiker, 'sticker.webp', '', m)
    else if (typeof stiker === 'string') throw stiker
    else throw `A conversão falhou, tente responder a uma imagem/vídeo com *${usedPrefix + command}*`
  }
}
handler.help = ['s', 'sticker']
handler.tags = ['sticker']
handler.command = ['s', 'sticker']

export default handler

const isUrl = (text) => {
  return text.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)(jpe?g|gif|png)/, 'gi'))
}
