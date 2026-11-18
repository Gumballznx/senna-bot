import fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const VIDEO_LIMIT = 60 * 1024 * 1024        // até aqui vai como vídeo (toca no chat)
export const DOC_LIMIT = 1900 * 1024 * 1024        // limite do WhatsApp para documento é 2 GB
// Converter AV1/VP9 para h264 (veryfast) deixa o arquivo ~1,8x maior
const H264_GROWTH = 1.8

const mb = b => (b / (1024 * 1024)).toFixed(1)

async function videoCodec(file) {
    try {
        const { stdout } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${file}"`)
        return stdout.trim().toLowerCase()
    } catch { return '' }
}

/** Converte para h264 mantendo boa qualidade sem inflar demais o arquivo (máx 1080p). */
export async function toH264(input, output, timeoutMs = 240000) {
    await execAsync(`ffmpeg -y -i "${input}" -c:v libx264 -preset veryfast -crf 27 -pix_fmt yuv420p -vf "scale='min(1920,iw)':-2" -c:a aac -b:a 128k -movflags +faststart "${output}"`, { timeout: timeoutMs })
    return output
}

/**
 * Envia um vídeo do disco sempre na melhor qualidade:
 *  - h264 até 60 MB → vídeo (toca no chat)
 *  - outro codec (HEVC/VP9/AV1) até 80 MB → converte para H264; se couber em 60 MB, toca no chat
 *  - o resto → arquivo ORIGINAL como documento (sem converter: mais rápido e menor)
 */
export async function sendVideoSmart(conn, jid, filePath, fileName, caption = '', quoted = null) {
    let size = fs.statSync(filePath).size
    if (size > DOC_LIMIT) throw new Error(`Arquivo de ${mb(size)} MB passa do limite de 2 GB do WhatsApp.`)
    const codec = await videoCodec(filePath)
    const isH264 = /h264|avc/.test(codec)
    let toSend = filePath
    let tmpConverted = null

    let asVideo = false
    if (isH264 || !codec) {
        asVideo = size <= VIDEO_LIMIT
    } else if (size <= 80 * 1024 * 1024) {
        try {
            tmpConverted = filePath.replace(/\.mp4$/i, '') + `_h264_${Date.now()}.mp4`
            await toH264(filePath, tmpConverted)
            const cs = fs.statSync(tmpConverted).size
            if (cs <= VIDEO_LIMIT) { toSend = tmpConverted; size = cs; asVideo = true }
        } catch (e) {
            console.warn('[sendVideoSmart] conversão para h264 falhou, enviando original como documento:', e.message)
        }
    }

    const cap = `${caption}${caption ? '\n' : ''}📦 ${mb(size)} MB`
    try {
        if (asVideo) {
            return await conn.sendFile(jid, toSend, fileName, cap, quoted, false, { asVideo: true, mimetype: 'video/mp4' })
        }
        return await conn.sendMessage(jid, {
            document: { url: filePath },
            mimetype: 'video/mp4',
            fileName: /\.mp4$/i.test(fileName) ? fileName : `${fileName}.mp4`,
            caption: `${caption}${caption ? '\n' : ''}📦 ${mb(fs.statSync(filePath).size)} MB\n📁 Enviado como documento (qualidade máxima)`
        }, { quoted })
    } finally {
        if (tmpConverted) try { fs.unlinkSync(tmpConverted) } catch (_) {}
    }
}

export default sendVideoSmart
