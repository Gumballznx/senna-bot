import { driveSend, driveFolderSend } from './gdrive.js'
import { megaSend, megaFolderSend } from './mega.js'
import { mediafireSend, mediafireFolderSend } from './mediafire.js'
import { dropboxSend } from './dropbox.js'
import { yandexSend } from './yandex.js'
import { pcloudSend } from './pcloud.js'
import { githubSend, githubParse } from './github.js'
import { npmSend } from './npmpkg.js'

// Um só lugar que reconhece links de nuvem/código e chama o serviço certo.
// Os dois bots (Senna e Nazuna) usam este arquivo igual: findCloudLink(texto) → cloudSend(io, hit).
//
// Ordem importa: padrões de PASTA vêm antes dos de arquivo do mesmo serviço.

const URL_END = '[^\\s<>"\']*'

export const CLOUD_SERVICES = [
    { id: 'gdrive-pasta', label: 'Google Drive', re: new RegExp(`https?://drive\\.google\\.com/(?:drive/(?:u/\\d+/)?folders/|folderview\\?id=)${URL_END}`, 'i'), run: driveFolderSend },
    { id: 'gdrive', label: 'Google Drive', re: new RegExp(`https?://(?:drive\\.google\\.com/(?:file/d/|open\\?id=|uc\\?${URL_END}id=)|docs\\.google\\.com/(?:document|spreadsheets|presentation)/d/)${URL_END}`, 'i'), run: driveSend },
    { id: 'mega-pasta', label: 'MEGA', re: new RegExp(`https?://mega\\.nz/folder/${URL_END}`, 'i'), run: megaFolderSend },
    { id: 'mega', label: 'MEGA', re: new RegExp(`https?://mega\\.nz/file/${URL_END}`, 'i'), run: megaSend },
    { id: 'mediafire-pasta', label: 'MediaFire', re: new RegExp(`https?://(?:www\\.)?mediafire\\.com/folder/${URL_END}`, 'i'), run: mediafireFolderSend },
    { id: 'mediafire', label: 'MediaFire', re: new RegExp(`https?://(?:www\\.)?mediafire\\.com/(?:file|view|download)/${URL_END}`, 'i'), run: mediafireSend },
    { id: 'dropbox', label: 'Dropbox', re: new RegExp(`https?://(?:www\\.)?dropbox\\.com/(?:scl/(?:fi|fo)/|s/|sh/)${URL_END}`, 'i'), run: dropboxSend },
    { id: 'yandex', label: 'Yandex Disk', re: new RegExp(`https?://(?:disk\\.yandex\\.[a-z.]+|yadi\\.sk)/(?:d|i)/[\\w-]+${URL_END}`, 'i'), run: yandexSend },
    { id: 'pcloud', label: 'pCloud', re: new RegExp(`https?://[\\w.]*pcloud\\.(?:link|com)/publink/show\\?code=[A-Za-z0-9]+`, 'i'), run: pcloudSend },
    { id: 'npm', label: 'npm', re: new RegExp(`https?://(?:www\\.)?npmjs\\.com/package/${URL_END}`, 'i'), run: npmSend },
    // GitHub por último e só para links "baixáveis" (repo, tree, blob, release): ignora issues/PRs/actions
    { id: 'github', label: 'GitHub', re: new RegExp(`https?://(?:www\\.)?github\\.com/[\\w.-]+/[\\w.-]+${URL_END}`, 'i'), run: githubSend, accept: l => !!githubParse(l) }
]

/** Procura no texto o primeiro link de nuvem/código suportado. Retorna { id, label, link, run } ou null. */
export function findCloudLink(text) {
    const t = String(text || '')
    for (const s of CLOUD_SERVICES) {
        const m = t.match(s.re)
        if (!m) continue
        const link = m[0].replace(/[)\].,;!?]+$/, '')
        if (s.accept && !s.accept(link)) continue
        return { id: s.id, label: s.label, link, run: s.run }
    }
    return null
}

/** Baixa e envia o que o link aponta. `io` é a interface de envio do bot. */
export async function cloudSend(io, hit) {
    return hit.run(io, hit.link, `✅ *Auto DL: ${hit.label}*`)
}
