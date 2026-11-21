import { driveSend, driveFolderSend, driveFolderId } from '../lib/gdrive.js'
import { senaIO } from '../lib/cloudio.js'

let handler = async (m, { conn, args }) => {
	if (!args[0]) throw `✳️ Insira um link do Google Drive (arquivo ou pasta)`
	m.react(rwait)
	try {
		const io = senaIO(conn, m)
		if (/\/folders\/|folderview/i.test(args[0]) && driveFolderId(args[0])) await driveFolderSend(io, args[0])
		else await driveSend(io, args[0])
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
