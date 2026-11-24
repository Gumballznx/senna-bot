import { downloadContentFromMessage } from '@whiskeysockets/baileys'
import {
  patchAudioStickerProto,
  probeMediaBuffer,
  buildStickerWebp,
  buildStickerAudioOgg,
  sendAudioSticker,
  setPendingAudioSticker,
  getPendingAudioSticker,
  clearPendingAudioSticker,
  parseStickerAudioArgs,
  extractMediaTarget
} from '../lib/stickerAudio.js'

patchAudioStickerProto()

function formatUsage(usedPrefix, command, pending) {
  let pendingInfo = ''
  if (pending?.type === 'sticker') {
    pendingInfo = `\n\n📌 *Você já tem uma figurinha salva!* Agora responda a um *áudio* com *${usedPrefix + command}*.`
  } else if (pending?.type === 'audio') {
    pendingInfo = `\n\n📌 *Você já tem um áudio salvo!* Agora envie ou responda a uma *figurinha, imagem ou vídeo* com *${usedPrefix + command}*.`
  }

  return `🔊 *Sticker com Áudio*\n\nComo usar *${usedPrefix + command}*:\n` +
    `• *Vídeo direto (1 passo):* responda a um vídeo com som usando *${usedPrefix + command}*\n` +
    `• *Sticker/Imagem + Áudio (2 passos):*\n` +
    `  1. Responda a uma figurinha ou imagem com *${usedPrefix + command}*\n` +
    `  2. Responda a um áudio (até 10s) com *${usedPrefix + command}*\n` +
    `• *Trecho específico:* *${usedPrefix + command} 0:10* ou *${usedPrefix + command} 0:05 0:15*\n` +
    `• *Pack personalizado:* *${usedPrefix + command} Pack|Autor*\n` +
    `• *Limpar seleção:* *${usedPrefix + command} limpar*` +
    pendingInfo
}

async function downloadTargetBuffer(conn, m, target) {
  const q = m.quoted ? m.quoted : m
  let buf = await Promise.resolve(typeof q.download === 'function' ? q.download() : null).catch(() => null)
  if (Buffer.isBuffer(buf) && buf.length > 0) return buf

  if (target?.media?.mediaKey && target.media.mediaKey.length) {
    const stream = await downloadContentFromMessage(target.media, target.mediaType)
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const out = Buffer.concat(chunks)
    if (out.length > 0) return out
  }

  if (m.quoted) {
    const qid = m.quoted.id || m.msg?.contextInfo?.stanzaId
    const raw = qid ? await conn.loadMessage?.(m.chat, qid) : null
    if (raw?.message) {
      const origTarget = extractMediaTarget(raw.message)
      if (origTarget?.media?.mediaKey && origTarget.media.mediaKey.length) {
        const stream = await downloadContentFromMessage(origTarget.media, origTarget.mediaType)
        const chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        const out = Buffer.concat(chunks)
        if (out.length > 0) return out
      }
    }
  }

  return null
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  const userId = m.sender
  const chatId = m.chat
  const parsed = parseStickerAudioArgs(text, global.packname, global.author)

  if (parsed.action === 'clear') {
    const cleared = clearPendingAudioSticker(chatId, userId)
    return m.reply(cleared
      ? '🗑️ Mídia salva limpa com sucesso.'
      : 'ℹ️ Você não tinha nenhuma mídia pendente para sticker com áudio.')
  }

  const pending = getPendingAudioSticker(chatId, userId)
  if (parsed.action === 'help') {
    return m.reply(formatUsage(usedPrefix, command, pending))
  }

  const rawQuoted = m.msg?.contextInfo?.quotedMessage || m.quoted?.vM?.message || null
  const target = (rawQuoted ? extractMediaTarget(rawQuoted) : null) || extractMediaTarget(m.message)

  if (!target) {
    return m.reply(formatUsage(usedPrefix, command, pending))
  }

  const isViewOnce = Boolean(
    rawQuoted?.viewOnceMessage || rawQuoted?.viewOnceMessageV2 || rawQuoted?.viewOnceMessageV2Extension ||
    m.quoted?.viewOnce || m.quoted?.msg?.viewOnce
  )

  const buffer = await downloadTargetBuffer(conn, m, target)
  if (!buffer || buffer.length === 0) {
    if (isViewOnce) {
      throw `⚠️ Essa é uma mídia de *visualização única* e o WhatsApp não entregou o conteúdo dela para o bot.\n\nPeça para reenviar normalmente e use *${usedPrefix + command}*.`
    }
    throw `❌ Não consegui baixar a mídia. Responda a uma figurinha, imagem, vídeo ou áudio com *${usedPrefix + command}*.`
  }

  if (typeof m.react === 'function') m.react('⏳')

  try {
    if (target.kind === 'video') {
      if (pending?.type === 'audio') {
        const webpData = await buildStickerWebp(buffer, {
          isVideo: true,
          packname: parsed.packname,
          author: parsed.author,
          startSeconds: parsed.startSeconds,
          maxDuration: 5
        })
        await sendAudioSticker(conn, chatId, {
          preConvertedWebp: webpData,
          preConvertedAudio: pending.data,
          quoted: m
        })
        clearPendingAudioSticker(chatId, userId)
        if (typeof m.react === 'function') m.react('✅')
        return
      }

      const probe = await probeMediaBuffer(buffer, 'mp4')
      const webpData = await buildStickerWebp(buffer, {
        isVideo: true,
        packname: parsed.packname,
        author: parsed.author,
        startSeconds: parsed.startSeconds,
        maxDuration: 5
      })

      if (probe.hasAudio) {
        const audioData = await buildStickerAudioOgg(buffer, {
          startSeconds: parsed.startSeconds,
          endSeconds: parsed.endSeconds,
          maxSeconds: 5,
          extHint: 'mp4'
        })
        await sendAudioSticker(conn, chatId, {
          preConvertedWebp: webpData,
          preConvertedAudio: audioData,
          quoted: m
        })
        if (typeof m.react === 'function') m.react('✅')
        return
      }

      setPendingAudioSticker(chatId, userId, { type: 'sticker', data: webpData })
      if (typeof m.react === 'function') m.react('🎵')
      return m.reply(`✅ Vídeo convertido para figurinha (sem áudio detectado)!\n\nAgora responda a um *áudio* (até 10s) com *${usedPrefix + command}* para finalizar.`)
    }

    if (target.kind === 'sticker' || target.kind === 'image') {
      const webpData = await buildStickerWebp(buffer, {
        isVideo: false,
        packname: parsed.packname,
        author: parsed.author
      })

      if (pending?.type === 'audio') {
        await sendAudioSticker(conn, chatId, {
          preConvertedWebp: webpData,
          preConvertedAudio: pending.data,
          quoted: m
        })
        clearPendingAudioSticker(chatId, userId)
        if (typeof m.react === 'function') m.react('✅')
        return
      }

      setPendingAudioSticker(chatId, userId, { type: 'sticker', data: webpData })
      if (typeof m.react === 'function') m.react('🎵')
      return m.reply(`✅ ${target.kind === 'sticker' ? 'Figurinha' : 'Imagem'} salva!\n\nAgora responda a um *áudio* (até 10s) com *${usedPrefix + command}* para criar seu sticker com áudio.`)
    }

    if (target.kind === 'audio') {
      const audioData = await buildStickerAudioOgg(buffer, {
        startSeconds: parsed.startSeconds,
        endSeconds: parsed.endSeconds,
        maxSeconds: 10
      })

      if (pending?.type === 'sticker') {
        await sendAudioSticker(conn, chatId, {
          preConvertedWebp: pending.data,
          preConvertedAudio: audioData,
          quoted: m
        })
        clearPendingAudioSticker(chatId, userId)
        if (typeof m.react === 'function') m.react('✅')
        return
      }

      setPendingAudioSticker(chatId, userId, { type: 'audio', data: audioData })
      if (typeof m.react === 'function') m.react('🖼️')
      return m.reply(`✅ Áudio salvo (${audioData.seconds}s)!\n\nAgora envie ou responda a uma *figurinha, imagem ou vídeo* com *${usedPrefix + command}* para gerar seu sticker com áudio.`)
    }
  } catch (err) {
    if (typeof m.react === 'function') m.react('❌')
    if (err?.message === 'NO_AUDIO_STREAM') {
      return m.reply('❌ Esse arquivo não contém nenhuma faixa de áudio válida.')
    }
    if (err?.message === 'START_AFTER_END') {
      return m.reply('❌ O tempo inicial informado é maior que a duração do áudio.')
    }
    console.error('[STICKER-AUDIO]', err)
    return m.reply('❌ Ocorreu um erro ao gerar o sticker com áudio. Tente novamente.')
  }
}

handler.help = ['figaudio', 'stickeraudio', 'saudio']
handler.tags = ['sticker']
handler.command = ['figaudio', 'stickeraudio', 'saudio']

export default handler
