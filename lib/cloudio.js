// Interface de envio do Senna para os módulos de nuvem (lib/cloudlinks.js e serviços).
// Os módulos só conhecem { text, document, video }; aqui ligamos isso ao WhatsApp via `conn` e `m`.
import { sendVideoSmart } from './sendVideo.js'

export const senaIO = (conn, m) => ({
    text: t => conn.sendMessage(m.chat, { text: t }, { quoted: m }),
    document: ({ filePath, mimetype, fileName, caption }) =>
        conn.sendMessage(m.chat, { document: { url: filePath }, mimetype, fileName, caption }, { quoted: m }),
    video: ({ filePath, fileName, caption }) => sendVideoSmart(conn, m.chat, filePath, fileName, caption, m, { legendaPronta: true })
})
