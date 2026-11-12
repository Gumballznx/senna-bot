import { canLevelUp } from '../lib/levelling.js'

export async function before(m, { conn }) {
    if (m.isGroup) {
        const botJid = conn.user?.jid || (conn.user?.id ? conn.decodeJid(conn.user.id) : '')
        let chat = global.db.data.chats[m.chat]
        let botSettings = global.db.data.settings?.[botJid] || {}
        if (botSettings.restrictgp) {
            const hasLicense = chat?.expired === -1 || (chat?.expired && chat.expired > Date.now())
            if (!hasLicense) return !0
        }
    }
    let user = global.db.data.users[m.sender]
    if (!user.autolevelup)
        return !0
    let before = user.level * 1
    while (canLevelUp(user.level, user.exp, global.multiplier))
        user.level++
    user.role = global.rpg.role(user.level).name
    if (before !== user.level) {
        m.reply(`
*▢ SUBISTE DE NIVEL*

 *${before}* ‣  *${user.level}*
 Rango : *${user.role}*
`.trim())
    }
}
