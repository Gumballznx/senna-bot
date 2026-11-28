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

    const { displayJid, changed } = await setUserBanned(conn, user, m.isGroup ? m.chat : undefined, true)
    let number = displayJid.split('@')[0]
    if (!changed) {
        return conn.reply(m.chat, `⚠️ JÁ ESTAVA BANIDO\n\n───────────\n@${number} já estava banido, nada foi alterado.`, m, { mentions: [displayJid] })
    }
    conn.reply(m.chat, `✅ BANIDO\n\n───────────\n@${number} Já não poderá usar meus comandos!`, m, { mentions: [displayJid] })
}
handler.help = ['ban @user']
handler.tags = ['owner']
handler.command = ['ban']
handler.rowner = true

export default handler
