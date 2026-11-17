import fs from 'fs'
import { sendVideoSmart } from '../lib/sendVideo.js'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

let handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!args[0]) throw `✳️ Insira um Link do Facebook\n\n📌 Exemplo :\n*${usedPrefix + command}* https://fb.watch/d7nB8-L-gR/`
  m.react('⏳')

  const TEMP_DIR = path.join(process.cwd(), 'tmp')
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
  const rawPath = path.join(TEMP_DIR, `fb_raw_${Date.now()}.mp4`)

  try {
    const { downloadFacebookToFile } = await import('../lib/facebook.js')
    await downloadFacebookToFile(args[0], rawPath)
    if (!fs.existsSync(rawPath)) throw new Error('Não foi possível baixar o Facebook.')
    await sendVideoSmart(conn, m.chat, rawPath, 'facebook.mp4', `✅ *Facebook*`, m)
    m.react('✅')
  } catch (error) {
    console.error('Facebook DL Error:', error.message)
    m.react('❌')
    m.reply("❎ Erro ao baixar Facebook \n\nVerifique se o link é público...")
  } finally {
    if (fs.existsSync(rawPath)) try { fs.unlinkSync(rawPath) } catch (_) {}
  }
}
handler.help = ['facebook'].map(v => v + ' <url>')
handler.tags = ['dl']
handler.command = /^((facebook|fb)(downloder|dl)?)$/i
handler.diamond = true

export default handler
