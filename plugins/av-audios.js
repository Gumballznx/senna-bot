let handler = m => m
handler.all = async function (m) {
  if (m.isGroup) {
    const botJid = this.user?.jid || (this.user?.id ? this.decodeJid(this.user.id) : '')
    let chat = global.db.data.chats[m.chat]
    let botSettings = global.db.data.settings?.[botJid] || {}
    if (botSettings.restrictgp) {
      const hasLicense = chat?.expired === -1 || (chat?.expired && chat.expired > Date.now())
      if (!hasLicense) return !0
    }
  }
  for (const message in audioMsg) {
    if (new RegExp(`^${message}$`, 'i').test(m.text)) {
     this.sendFile(m.chat, audioMsg[message], 'audio.mp3', null, m, false)

     break
    }
  }
  return !0
 }

export default handler

let audioMsg = {
  'fino señores': './src/mp3/fino.mp3',
  'buenos días': 'https://k.top4top.io/m_2826iqdri1.mp3',
  'buenas tardes': 'https://b.top4top.io/m_2826v2zg51.mp3',
  'buenas noches': 'https://i.top4top.io/m_2826o8rfj1.mp3',
  'sad': 'https://h.top4top.io/m_2826mcim21.mp3',
  '@246252335804458': 'https://l.top4top.io/m_2492i4mdu1.mp3'
}
