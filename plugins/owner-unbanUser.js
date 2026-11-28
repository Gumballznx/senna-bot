import { setUserBanned } from '../lib/banHelper.js'

let handler = async (m, { conn, text, usedPrefix, command }) => {
    let user
    if (m.quoted) {
        user = m.quoted.sender
    } else if (m.mentionedJid && m.mentionedJid[0]) {
        user = m.mentionedJid[0]
    } else if (text) {
        let txt = text.replace(/[^0-9]/g, '')
        if (txt) user = txt + '@s.whatsapp.net'
    }

    if (!user) {
        return m.reply(`✳️ Mencione o usuário ou responda a uma de suas mensagens\n\n📌 Exemplo: ${usedPrefix + command} @user`)
    }

    const { displayJid, changed } = await setUserBanned(conn, user, m.isGroup ? m.chat : undefined, false)
    let number = displayJid.split('@')[0]
    if (!changed) {
        return conn.reply(m.chat, `⚠️ NÃO ESTAVA BANIDO\n\n───────────\n@${number} não está banido, nada foi alterado.`, m, { mentions: [displayJid] })
    }
    conn.reply(m.chat, `✅ DESBANIDO\n\n───────────\n@${number} Foi desbanido e pode voltar a usar meus comandos!`, m, { mentions: [displayJid] })
}
handler.help = ['unban @user']
handler.tags = ['owner']
handler.command = ['unban']
handler.rowner = true

export default handler
