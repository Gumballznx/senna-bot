import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { sendVideoSmart } from '../lib/sendVideo.js'

const execAsync = promisify(exec)

let handler = async (m, { conn, args, usedPrefix, command }) => {
    if (!args[0]) throw `✳️ Insira um link da Twitch (Clipe ou Vídeo)\n\n📌 Exemplo :\n*${usedPrefix + command}* https://clips.twitch.tv/OutstandingGracefulMomResidentSleeper`
    m.react('⏳')

    const url = args[0].trim()
    const twitchRegex = /https?:\/\/(www\.|clips\.|m\.)?twitch\.tv\/[^\s]+/i
    if (!twitchRegex.test(url)) throw '❌ Link da Twitch inválido. Envie um link de clipe ou vídeo da Twitch.'

    const TEMP_DIR = path.join(process.cwd(), 'tmp')
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
    const rawPath = path.join(TEMP_DIR, `twitch_raw_${Date.now()}.mp4`)

    try {
        let success = false

        // 1. Tenta via Cobalt
        try {
            const { downloadCobalt } = await import('../lib/ytHelper.js')
            const cobaltRes = await downloadCobalt(url)
            if (cobaltRes?.filePath && fs.existsSync(cobaltRes.filePath)) {
                await sendVideoSmart(conn, m.chat, cobaltRes.filePath, cobaltRes.title || 'twitch.mp4', `✅ *Twitch*`, m)
                if (fs.existsSync(cobaltRes.filePath)) try { fs.unlinkSync(cobaltRes.filePath) } catch (_) {}
                success = true
            }
        } catch (e) {
            console.warn('[Twitch DL] Cobalt falhou, tentando yt-dlp:', e.message)
        }

        // 2. Fallback via yt-dlp
        if (!success) {
            await execAsync(`yt-dlp -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" --merge-output-format mp4 -o "${rawPath}" "${url}"`, { timeout: 180000 })
            if (fs.existsSync(rawPath)) {
                await sendVideoSmart(conn, m.chat, rawPath, 'twitch.mp4', `✅ *Twitch*`, m)
                success = true
            }
        }

        if (!success) throw new Error('Não foi possível obter o vídeo da Twitch.')
        m.react('✅')
    } catch (error) {
        console.error('Twitch DL Error:', error.message)
        m.react('❌')
        m.reply(`❎ Erro ao baixar da Twitch: ${error.message || 'Falha no download'}`)
    } finally {
        if (fs.existsSync(rawPath)) try { fs.unlinkSync(rawPath) } catch (_) {}
    }
}

handler.help = ['twitch <url>', 'ttv <url>']
handler.tags = ['dl']
handler.command = /^(twitch|ttv|clip(twitch)?)$/i
handler.diamond = true

export default handler
