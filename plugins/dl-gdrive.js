import { driveSend } from '../lib/gdrive.js'

let handler = async (m, { conn, args }) => {
	if (!args[0]) throw `✳️ Insira um link do Google Drive`
	m.react(rwait)
	try {
		await driveSend(conn, m, args[0])
		m.react(done)
	} catch (e) {
		console.error('[gdrive] erro:', e)
		m.react('❌')
		m.reply(`❎ Erro ao baixar do Google Drive: ${e.message}`)
	}
}
handler.help = ['gdrive']
handler.tags = ['dl', 'prem']
handler.command = ['gdrive']

export default handler
