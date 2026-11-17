import fs from 'fs'

export const VIDEO_LIMIT = 60 * 1024 * 1024        // até aqui vai como vídeo (toca no chat)
export const DOC_LIMIT = 1900 * 1024 * 1024        // limite do WhatsApp para documento é 2 GB

const mb = b => (b / (1024 * 1024)).toFixed(1)

/**
 * Envia um vídeo do disco: até 60 MB como vídeo, acima disso como documento.
 * Documentos são enviados lendo direto do disco (não carrega o arquivo inteiro na memória).
 */
export async function sendVideoSmart(conn, jid, filePath, fileName, caption = '', quoted = null) {
    const size = fs.statSync(filePath).size
    const cap = `${caption}${caption ? '\n' : ''}📦 ${mb(size)} MB`
    if (size > DOC_LIMIT) throw new Error(`Arquivo de ${mb(size)} MB passa do limite de 2 GB do WhatsApp.`)
    if (size <= VIDEO_LIMIT) {
        return conn.sendFile(jid, filePath, fileName, cap, quoted, false, { asVideo: true, mimetype: 'video/mp4' })
    }
    return conn.sendMessage(jid, {
        document: { url: filePath },
        mimetype: 'video/mp4',
        fileName: /\.mp4$/i.test(fileName) ? fileName : `${fileName}.mp4`,
        caption: `${cap}\n📁 Enviado como documento (maior que 60 MB)`
    }, { quoted })
}

export default sendVideoSmart
