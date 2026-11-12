let handler = async (m, { conn, usedPrefix, command }) => {
    let user = global.db.data.users[m.sender]
    let ownerNumber = Array.isArray(global.owner[0]) ? global.owner[0][0] : global.owner[0]
    let isPrem = user?.prem || false
    let remainingTime = ''

    if (isPrem) {
        let timeLeft = (user.premiumTime || 0) - Date.now()
        if (user.premiumTime === -1) {
            remainingTime = 'Vitalício (Permanente)'
        } else if (timeLeft > 0) {
            let days = Math.floor(timeLeft / (1000 * 60 * 60 * 24))
            let hours = Math.floor((timeLeft / (1000 * 60 * 60)) % 24)
            remainingTime = `${days} dias e ${hours} horas`
        } else {
            remainingTime = 'Expirado'
            user.prem = false
        }
    }

    let text = `
👑 *STATUS PREMIUM / VIP*

📌 *Usuário:* @${m.sender.split`@`[0]}
💠 *Status:* ${isPrem ? '🟢 *ATIVO*' : '🔴 *INATIVO*'}
${isPrem ? `⏳ *Validade:* ${remainingTime}` : `
💎 *Vantagens Premium:*
• Comandos exclusivos sem restrição
• Diamantes infinitos para recursos especiais
• Prioridade no uso do bot

Para adquirir o Premium, entre em contato com o proprietário:
📞 *wa.me/${ownerNumber}*`}
`.trim()

    await conn.reply(m.chat, text, m, { mentions: [m.sender] })
}

handler.help = ['premium', 'prem']
handler.tags = ['prem']
handler.command = ['premium', 'prem', 'vip']

export default handler
