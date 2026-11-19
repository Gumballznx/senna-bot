import fg from 'fg-senna'
import { downloadYT } from '../lib/ytHelper.js'
import { sendVideoSmart, VIDEO_LIMIT } from '../lib/sendVideo.js'
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const processedLinks = new Map()
const DEDUP_TTL = 3 * 60 * 1000 // 3 minutos anti-duplicados por chat

function isRecent(key) {
    const time = processedLinks.get(key)
    return !!(time && (Date.now() - time < DEDUP_TTL))
}

function markRecent(key) {
    processedLinks.set(key, Date.now())
    if (processedLinks.size > 500) {
        const now = Date.now()
        for (const [k, v] of processedLinks.entries()) {
            if (now - v > DEDUP_TTL) processedLinks.delete(k)
        }
    }
}

export async function before(m, { conn, isOwner }) {
    if (m.isBaileys || m.fromMe || !m.text) return false
    let chat = global.db.data.chats[m.chat]
    const autodlAtivo = m.isGroup ? !!(chat && chat.autodl) : true
    if (!autodlAtivo) return false

    if (m.isGroup && !isOwner) {
        const botJid = conn.user?.jid || (conn.user?.id ? conn.decodeJid(conn.user.id) : '')
        let botSettings = global.db.data.settings?.[botJid] || {}
        if (botSettings.restrictgp) {
            const hasLicense = chat?.expired === -1 || (chat?.expired && chat.expired > Date.now())
            if (!hasLicense) return false
        }
    }

    let text = m.text

    if (global.prefix.test(text)) return false

    const tiktokRegex = /https?:\/\/(www\.|v[mt]\.|vt\.)?tiktok\.com\/[^\s]*|https?:\/\/(www\.)?tt\.site\/[^\s]*/i
    const facebookRegex = /https?:\/\/(www\.|web\.|m\.)?(facebook\.com|fb\.watch|fb\.com)\/[^\s]*/i
    const instagramRegex = /https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|stories)\/[^\s]+|https?:\/\/instagr\.am\/[^\s]+/i
    const mediafireRegex = /https?:\/\/(www\.)?mediafire\.com\/file\/[^\s]*/i
    const megaRegex = /https?:\/\/mega\.nz\/file\/[^\s]*/i
    const youtubeRegex = /https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\/[^\s]*/i
    const twitterRegex = /https?:\/\/(www\.)?(twitter\.com|x\.com)\/[^\s]+/i
    const pinterestRegex = /https?:\/\/([a-z]+\.)?(pinterest\.[a-z.]+\/pin|pin\.it)\/[^\s]*/i
    const twitchRegex = /https?:\/\/(www\.|clips\.|m\.)?twitch\.tv\/[^\s]+/i
    const xvideosRegex = /https?:\/\/(www\.)?(xvideos\.com|xvideos\d*\.com)\/[^\s]+/i
    const xnxxRegex = /https?:\/\/(www\.)?(xnxx\.com|xnxx\d*\.com)\/[^\s]+/i

    const checkNsfwAccess = () => {
        if (m.isGroup && !chat?.nsfw) {
            m.reply(`🚫 Downloads de conteúdo adulto (+18) estão desativados neste grupo.\n\nPara ativar, um administrador deve usar:\n*.on nsfw*`)
            return false
        }
        let user = global.db.data.users[m.sender]
        if (!user?.registered) {
            m.reply(`🔞 Downloads +18 requerem registro de maioridade!\n\nRegistre-se usando:\n*.reg Nome+Idade+Gênero*\n(Exemplo: *.reg Carlos+20+M*)`)
            return false
        }
        if ((user.age || 0) < 18) {
            m.reply(`🔞 Acesso negado: Você é menor de 18 anos!`)
            return false
        }
        return true
    }

    let found = false

    if (tiktokRegex.test(text)) {
        let link = text.match(tiktokRegex)[0]
        if (/tt\.site/i.test(link)) {
            try {
                const resp = await fetch(link, { method: 'HEAD', redirect: 'follow' })
                if (resp?.url) link = resp.url
            } catch (e) {}
        }
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            let success = false

            try {
                let data = null
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        data = await fg.tiktok(link)
                        if (data?.result?.play || data?.result?.images) break
                    } catch (e) {
                        console.error(`fg-senna TikTok attempt ${attempt} failed:`, e.message)
                    }
                    if (attempt < 3) {
                        await new Promise(resolve => setTimeout(resolve, 1200))
                    }
                }

                if (data && data.result && data.result.images) {
                    const images = data.result.images.slice(0, 5)
                    for (let img of images) {
                        await conn.sendFile(m.chat, img, 'tiktok.png', '', m, null, fwc)
                        await new Promise(resolve => setTimeout(resolve, 1200))
                    }
                    if (data.result.images.length > 5) {
                        await conn.reply(m.chat, `ℹ️ Mostrando 5 de ${data.result.images.length} fotos do carrossel para evitar flood.`, m)
                    }
                    success = true
                    m.react(done)
                } else if (data && data.result && data.result.play) {
                    await conn.sendFile(m.chat, data.result.play, 'tiktok.mp4', `✅ *Auto DL: TikTok*`, m, null, fwc)
                    success = true
                    m.react(done)
                }
            } catch (ee) {
                console.error('fg-senna TikTok failed:', ee.message)
            }

            if (!success) {
                const TEMP_DIR = path.join(process.cwd(), 'tmp')
                if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
                const rawPath = path.join(TEMP_DIR, `tk_raw_${Date.now()}.mp4`)
                const finalPath = path.join(TEMP_DIR, `tk_${Date.now()}.mp4`)

                try {
                    await execAsync(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${rawPath}" "${link}"`, { timeout: 120000 })
                    if (fs.existsSync(rawPath)) {
                        await execAsync(`ffmpeg -i "${rawPath}" -c:v copy -c:a aac -b:a 128k -movflags +faststart -y "${finalPath}"`, { timeout: 180000 })
                        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath)
                        if (fs.existsSync(finalPath)) {
                            await conn.sendFile(m.chat, finalPath, 'tiktok.mp4', `✅ *Auto DL: TikTok (HD)*`, m, null, fwc)
                            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
                            success = true
                            m.react(done)
                        }
                    }
                } catch (ee) {
                    console.error('yt-dlp TikTok failed')
                }
            }

            if (!success) throw new Error('Não foi possível obter o link do vídeo TikTok')
        } catch (e) {
            console.error('AutoDL TikTok Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao baixar TikTok: ${e.message}`)
        }
    }

    if (!found && instagramRegex.test(text)) {
        // Remove parâmetros de rastreio (?dlrf=, ?igsh=, ?utm_...) que atrapalham alguns extratores
        let link = text.match(instagramRegex)[0].split('?')[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            // Mesma API usada pelo fg.igdl, mas pegando TODOS os itens (carrossel); fg.igdl só devolve o 1º
            let data = null
            try {
                const axiosIg = (await import('axios')).default
                const { data: all } = await axiosIg.get(`https://backend1.tioo.eu.org/igdl?url=${encodeURIComponent(link)}`, { timeout: 12000 })
                if (Array.isArray(all) && all.length) data = { result: all.map(i => ({ url: i.url })) }
            } catch (e) { var igApiDown = true }
            // fg.igdl usa a mesma API; se ela caiu, não adianta esperar por ele
            if (!data && typeof igApiDown === 'undefined') data = await Promise.race([
                fg.igdl(link).catch(() => null),
                new Promise(resolve => setTimeout(() => resolve(null), 20000))
            ])
            let success = false

            let mediaList = []
            if (data?.result && Array.isArray(data.result) && data.result.length > 0) {
                mediaList = data.result.map(i => i.url || i.dl_url).filter(Boolean)
            } else if (data?.dl_url) {
                mediaList = [data.dl_url]
            } else if (data?.url) {
                mediaList = [data.url]
            }

            if (mediaList.length > 0) {
                const axios = (await import('axios')).default
                const sharp = (await import('sharp')).default
                const maxMedia = 5
                const mediaToSend = mediaList.slice(0, maxMedia)
                for (let mediaUrl of mediaToSend) {
                    try {
                        const res = await axios.get(mediaUrl, {
                            responseType: 'arraybuffer',
                            headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' },
                            timeout: 20000
                        })
                        let buffer = Buffer.from(res.data)
                        const isVideo = mediaUrl.includes('.mp4') || (res.headers['content-type'] && res.headers['content-type'].includes('video')) || buffer.toString('utf8', 4, 12).includes('ftyp')
                        if (!isVideo) {
                            if (buffer.slice(0, 4).toString() === 'RIFF') {
                                try {
                                    buffer = await sharp(buffer).jpeg({ quality: 92 }).toBuffer()
                                } catch (_) {}
                            }
                            await conn.sendFile(m.chat, buffer, 'instagram.jpg', `✅ *Auto DL: Instagram*`, m, null, fwc)
                        } else {
                            await conn.sendFile(m.chat, buffer, 'instagram.mp4', `✅ *Auto DL: Instagram*`, m, null, fwc)
                        }
                        success = true
                        await new Promise(resolve => setTimeout(resolve, 1200))
                    } catch (dlErr) {
                        console.error('❌ [AutoDL IG] Erro ao baixar buffer:', dlErr.message)
                    }
                }
                if (mediaList.length > maxMedia && success) {
                    await conn.reply(m.chat, `ℹ️ Mostrando 5 de ${mediaList.length} mídias deste álbum para evitar flood.`, m)
                }
                if (success) {
                    m.react(done)
                    return
                }
            }

            if (!success) {
                const TEMP_DIR = path.join(process.cwd(), 'tmp')
                if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
                const rawPath = path.join(TEMP_DIR, `ig_raw_${Date.now()}.mp4`)
                const finalPath = path.join(TEMP_DIR, `ig_${Date.now()}.mp4`)

                try {
                    let cookiesFlag = ''
                    const cookiesPath = path.join(process.cwd(), 'cookies.txt')
                    if (fs.existsSync(cookiesPath)) cookiesFlag = `--cookies "${cookiesPath}"`

                    await execAsync(`yt-dlp ${cookiesFlag} -f "bestvideo[vcodec^=avc]+bestaudio/best[vcodec^=avc]/bestvideo+bestaudio/best" --merge-output-format mp4 -o "${rawPath}" "${link}"`, { timeout: 90000 })
                    if (fs.existsSync(rawPath)) {
                        let codec = 'h264'
                        try {
                            const { stdout } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rawPath}"`)
                            if (stdout) codec = stdout.trim().toLowerCase()
                        } catch (_) {}

                        const ffmpegCmd = (codec === 'h264' || codec === 'h264(high)')
                            ? `ffmpeg -i "${rawPath}" -c:v copy -c:a aac -b:a 128k -movflags +faststart -y "${finalPath}"`
                            : `ffmpeg -i "${rawPath}" -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -b:a 128k -movflags +faststart -y "${finalPath}"`

                        await execAsync(ffmpegCmd, { timeout: 60000 })
                        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath)
                        if (fs.existsSync(finalPath)) {
                            await conn.sendFile(m.chat, finalPath, 'ig.mp4', `✅ *Auto DL: Instagram*`, m, null, fwc)
                            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
                            success = true
                        }
                    }
                } catch(e) {
                    console.error('❌ [AutoDL IG] yt-dlp falhou:', e.message)
                    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath) } catch(_) {}
                    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath) } catch(_) {}
                    if (/isn't available to everyone|login required|confirm your age|age-restricted|private account/i.test(e.message)) {
                        m.react('❌')
                        return m.reply('🔒 Este conteúdo do Instagram possui restrição de privacidade ou idade e não pode ser baixado.')
                    }
                }
            }

            if (!success) {
                const fetch = (await import('node-fetch')).default;
                let url = data?.dl_url || (data?.result && data.result[0]?.url)

                if (!url) {
                    try {
                        let rz = await fetch(`https://api.ryzendesu.vip/api/downloader/igdl?url=${encodeURIComponent(link)}`, { timeout: 10000 }).then(v => v.json()).catch(() => null);
                        url = rz?.url || rz?.data?.url || rz?.result?.[0]?.url;
                    } catch(e) {}
                }

                if (!url) {
                    try {
                        let sp = await fetch(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(link)}`, { timeout: 10000 }).then(v => v.json()).catch(() => null);
                        url = sp?.data?.[0]?.url || sp?.data?.url;
                    } catch(e) {}
                }

                if (url) {
                    try {
                        await conn.sendFile(m.chat, url, 'ig.mp4', `✅ *Auto DL: Instagram*`, m, null, fwc)
                        success = true
                    } catch(e) {
                        console.error('❌ [AutoDL IG] Envio da API falhou:', e.message)
                    }
                }
            }

            if (!success) throw new Error('Não foi possível obter a URL de download em nenhum motor.')
            m.react(done)
        } catch (e) {
            console.error('AutoDL Instagram Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao baixar Instagram: ${e.message}`)
        }
    }

    if (!found && facebookRegex.test(text)) {
        let link = text.match(facebookRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        const TEMP_DIR = path.join(process.cwd(), 'tmp')
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
        const rawPath = path.join(TEMP_DIR, `fb_raw_${Date.now()}.mp4`)
        try {
            const { downloadFacebookToFile } = await import('../lib/facebook.js')
            await downloadFacebookToFile(link, rawPath)
            if (!fs.existsSync(rawPath)) throw new Error('Falha ao baixar vídeo do Facebook.')
            // h264 até 60 MB vai como vídeo; AV1 pequeno é convertido; o resto vai como documento na qualidade máxima
            await sendVideoSmart(conn, m.chat, rawPath, 'facebook.mp4', `✅ *Auto DL: Facebook*`, m)
            m.react(done)
        } catch (e) {
            console.error('AutoDL Facebook Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao baixar Facebook: Verifique se o link é público.`)
        } finally {
            if (fs.existsSync(rawPath)) try { fs.unlinkSync(rawPath) } catch (_) {}
        }
    }

    if (!found && twitterRegex.test(text)) {
        if (!checkNsfwAccess()) return true
        let link = text.match(twitterRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            let tweetIdMatch = link.match(/\/status\/(\d+)/);
            if (!tweetIdMatch) throw new Error('Link do Twitter inválido ou sem ID do post.');

            let id = tweetIdMatch[1];
            let directUrl = null;
            let success = false;
            const fetch = (await import('node-fetch')).default;

            const safeSend = async (file, fileName, cap, opts) => {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await conn.sendFile(m.chat, file, fileName, cap, m, null, opts)
                        return true
                    } catch (err) {
                        console.error(`[Twitter AutoDL Send Attempt ${attempt}/3 failed]: ${err.message}`)
                        if (attempt === 3) throw err
                        await new Promise(res => setTimeout(res, 2500))
                    }
                }
                return false
            }

            try {
                let vx = await fetch(`https://api.vxtwitter.com/Twitter/status/${id}`).then(v => v.json());
                if (vx && vx.media_extended && vx.media_extended.length > 0) {
                    let videoMedia = vx.media_extended.find(xx => xx.type === 'video');
                    if (videoMedia) directUrl = videoMedia.url;
                } else if (vx && vx.mediaURLs && vx.mediaURLs.length > 0) {
                    directUrl = vx.mediaURLs[0];
                }
            } catch(e) { }

            if (!directUrl) {
                try {
                    let fx = await fetch(`https://api.fxtwitter.com/Twitter/status/${id}`).then(v => v.json());
                    let videoMedia = fx?.tweet?.media?.video;
                    if (videoMedia && videoMedia.url) { directUrl = videoMedia.url; }
                } catch(e) { }
            }

            if (directUrl) {
                try {
                    const axios = (await import('axios')).default
                    let headRes = await axios.head(directUrl, { timeout: 8000 }).catch(() => null)
                    if (headRes && headRes.status === 200) {
                        let contentLength = parseInt(headRes.headers['content-length'] || '0')
                        let isDoc = contentLength > 60 * 1024 * 1024
                        success = await safeSend(directUrl, 'twitter.mp4', `✅ *Auto DL: Twitter/X*`, isDoc ? { asDocument: true } : fwc)
                    }
                } catch(e) {
                    console.error('Enviar directUrl Twitter falhou:', e.message)
                }
            }

            if (!success) {
                try {
                    const { downloadCobalt } = await import('../lib/ytHelper.js')
                    let cobaltRes = await downloadCobalt(link)
                    if (cobaltRes) {
                        if (cobaltRes.isPicker) {
                            for (let url of cobaltRes.items) {
                                await safeSend(url, 'twitter.mp4', `✅ *Auto DL: Twitter/X (Cobalt)*`, fwc)
                            }
                            success = true;
                        } else if (fs.existsSync(cobaltRes.filePath)) {
                            let stats = fs.statSync(cobaltRes.filePath)
                            let isDoc = stats.size > 60 * 1024 * 1024
                            success = await safeSend(cobaltRes.filePath, cobaltRes.title || 'twitter.mp4', `✅ *Auto DL: Twitter/X (Cobalt)*`, isDoc ? { asDocument: true } : fwc)
                            if (fs.existsSync(cobaltRes.filePath)) fs.unlinkSync(cobaltRes.filePath)
                        }
                    }
                } catch(e) { }
            }

            if (!success) {
                const TEMP_DIR = path.join(process.cwd(), 'tmp')
                if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
                const rawPath = path.join(TEMP_DIR, `tw_raw_${Date.now()}.mp4`)
                const finalPath = path.join(TEMP_DIR, `tw_${Date.now()}.mp4`)

                try {
                    await execAsync(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${rawPath}" "${link}"`, { timeout: 180000 })
                    if (fs.existsSync(rawPath)) {
                        await execAsync(`ffmpeg -i "${rawPath}" -c:v copy -c:a aac -b:a 128k -movflags +faststart -y "${finalPath}"`, { timeout: 300000 })
                        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath)
                        if (fs.existsSync(finalPath)) {
                            let stats = fs.statSync(finalPath)
                            let isDoc = stats.size > 60 * 1024 * 1024
                            success = await safeSend(finalPath, 'twitter.mp4', `✅ *Auto DL: Twitter/X (HD)*`, isDoc ? { asDocument: true } : fwc)
                            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
                        }
                    }
                } catch (ee) {
                    console.error('yt-dlp Twitter local failed:', ee.message)
                    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath)
                    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
                }
            }

            if (!success) throw new Error('Todas as conexões nativas do Twitter falharam.');
            m.react(done)
        } catch (e) {
            console.error('AutoDL Twitter Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao processar Twitter via Auto DL.`)
        }
    }

    if (!found && mediafireRegex.test(text)) {
        let link = text.match(mediafireRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            let data = await fg.mediafire(link)
            if (data.url) {
                let size = parseInt(data.size)
                let prefix = typeof global.prefix === 'string' ? global.prefix : '.'
                if (size > 1024 && data.size.includes('MB') && !isOwner) return m.reply(`✳️ Arquivo muito grande para AutoDL (Max 1GB). Use o comando ${prefix}mediafire para limites de até 3GB.`)
                await conn.sendFile(m.chat, data.url, data.filename, `✅ *Auto DL: Mediafire*`, m, null, { asDocument: true })
                m.react(done)
            }
        } catch (e) {
            console.error('AutoDL Mediafire Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao baixar Mediafire: ${e.message}`)
        }
    }

    if (!found && megaRegex.test(text)) {
        let link = text.match(megaRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            let data = await fg.mega(link)
            if (data.download) {
                await conn.sendFile(m.chat, data.download, data.filename, `✅ *Auto DL: MEGA*`, m, null, { asDocument: true })
                m.react(done)
            }
        } catch (e) {
            console.error('AutoDL MEGA Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao baixar MEGA: ${e.message}`)
        }
    }

    if (!found && youtubeRegex.test(text)) {
        let link = text.match(youtubeRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            let { filePath, size, title } = await downloadYT(link, 'video')
            if (fs.existsSync(filePath)) {

                if (size > 2000 * 1024 * 1024) {
                    fs.unlinkSync(filePath)
                    return m.reply('✳️ O arquivo superou o limite de 2GB do WhatsApp.')
                }

                await sendVideoSmart(conn, m.chat, filePath, `${title || 'video'}.mp4`, `✅ *Auto DL: YouTube*`, m)

                if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
                m.react(done)
            }
        } catch (e) {
            console.error('AutoDL YouTube Error:', e)
            m.react('❌')

            if (e.message.includes('upload')) {
                m.reply(`❎ Erro de Transmissão: O ficheiro é muito grande ou a conexão com o WhatsApp caiu. Tente novamente.`)
            } else {
                m.reply(`❎ Erro ao baixar YouTube: ${e.message}`)
            }
        }
    }

    if (!found && pinterestRegex.test(text)) {
        let link = text.match(pinterestRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        try {
            const { pinterestDownload } = await import('../lib/pinterest.js')
            const res = await pinterestDownload(link)
            if (res.type === 'video') {
                await conn.sendFile(m.chat, res.url, 'pinterest.mp4', `✅ *Auto DL: Pinterest*`, m, null, fwc)
            } else {
                for (let url of (res.urls || []).slice(0, 5)) {
                    await conn.sendFile(m.chat, url, 'pinterest.jpg', `✅ *Auto DL: Pinterest*`, m, null, fwc)
                    await new Promise(r => setTimeout(r, 1200))
                }
            }
            m.react(done)
        } catch (e) {
            console.error('AutoDL Pinterest Error:', e)
            m.react('❌')
            m.reply(`❎ Erro ao baixar Pinterest: ${e.message}`)
        }
    }

    if (!found && twitchRegex.test(text)) {
        let link = text.match(twitchRegex)[0]
        const dedupKey = `${m.chat}:${link}`
        if (isRecent(dedupKey)) return false
        markRecent(dedupKey)
        found = true
        m.react(rwait)
        const TEMP_DIR = path.join(process.cwd(), 'tmp')
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
        const rawPath = path.join(TEMP_DIR, `twitch_raw_${Date.now()}.mp4`)
        try {
            let success = false
            try {
                const { downloadCobalt } = await import('../lib/ytHelper.js')
                const cobaltRes = await downloadCobalt(link)
                if (cobaltRes?.filePath && fs.existsSync(cobaltRes.filePath)) {
                    await sendVideoSmart(conn, m.chat, cobaltRes.filePath, cobaltRes.title || 'twitch.mp4', `✅ *Auto DL: Twitch*`, m)
                    if (fs.existsSync(cobaltRes.filePath)) try { fs.unlinkSync(cobaltRes.filePath) } catch (_) {}
                    success = true
                }
            } catch (errCobalt) {
                console.warn('[AutoDL Twitch] Cobalt falhou, tentando yt-dlp:', errCobalt.message)
            }

            if (!success) {
                await execAsync(`yt-dlp -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" --merge-output-format mp4 -o "${rawPath}" "${link}"`, { timeout: 180000 })
                if (fs.existsSync(rawPath)) {
                    await sendVideoSmart(conn, m.chat, rawPath, 'twitch.mp4', `✅ *Auto DL: Twitch*`, m)
                    success = true
                }
            }

            if (!success) throw new Error('Falha ao baixar mídia da Twitch.')
            m.react(done)
        } catch (e) {
            console.error('AutoDL Twitch Error:', e.message)
            m.react('❌')
            m.reply(`❎ Erro ao baixar Twitch: ${e.message}`)
        } finally {
            if (fs.existsSync(rawPath)) try { fs.unlinkSync(rawPath) } catch (_) {}
        }
    }

    if (!found && xvideosRegex.test(text)) {
        if (!checkNsfwAccess()) return true
        let link = text.match(xvideosRegex)[0]
        found = true
        m.react(rwait)
        try {
            let videoUrl = null
            let title = 'Xvideos'
            let xv = await fg.xvideos(link).catch(() => null)
            if (xv?.url_dl) {
                videoUrl = xv.url_dl
                title = xv.title || title
            }
            if (!videoUrl) {
                const axios = (await import('axios')).default
                const cheerio = await import('cheerio')
                const res = await axios.get(link, {
                    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    timeout: 15000
                }).catch(() => null)
                if (res?.data) {
                    const $ = cheerio.load(res.data)
                    videoUrl = $('#html5video_base a').attr('href') || $('#html5video_base div a').attr('href') || res.data.match(/html5video\.setVideoUrlHigh\('([^']+)'\)/)?.[1] || res.data.match(/html5video\.setVideoUrlLow\('([^']+)'\)/)?.[1]
                    title = $('meta[property="og:title"]').attr('content') || title
                }
            }
            if (!videoUrl) {
                const TEMP_DIR = path.join(process.cwd(), 'tmp')
                if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
                const finalPath = path.join(TEMP_DIR, `xv_${Date.now()}.mp4`)
                await execAsync(`yt-dlp -f "best[ext=mp4]/best" -o "${finalPath}" "${link}"`, { timeout: 120000 })
                if (fs.existsSync(finalPath)) {
                    await conn.sendFile(m.chat, finalPath, 'xvideos.mp4', `✅ *Auto DL: Xvideos*\n\n📌 *Título:* ${title}`, m, false, { asDocument: chat?.useDocument })
                    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
                    m.react(done)
                    return true
                }
            }
            if (!videoUrl) throw new Error('Falha ao extrair vídeo do Xvideos.')
            await conn.sendFile(m.chat, videoUrl, (title || 'xvideos') + '.mp4', `✅ *Auto DL: Xvideos*\n\n📌 *Título:* ${title}`, m, false, { asDocument: chat?.useDocument })
            m.react(done)
        } catch (e) {
            console.error('AutoDL Xvideos Error:', e.message)
            m.react('❌')
            m.reply(`❎ Erro ao baixar Xvideos: ${e.message}`)
        }
    }

    if (!found && xnxxRegex.test(text)) {
        if (!checkNsfwAccess()) return true
        let link = text.match(xnxxRegex)[0]
        found = true
        m.react(rwait)
        try {
            let videoUrl = null
            let title = 'XNXX'
            let xn = await fg.xnxx(link).catch(() => null)
            if (xn?.url_dl) {
                videoUrl = xn.url_dl
                title = xn.title || title
            }
            if (!videoUrl) {
                const axios = (await import('axios')).default
                const cheerio = await import('cheerio')
                const res = await axios.get(link, {
                    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' },
                    timeout: 15000
                }).catch(() => null)
                if (res?.data) {
                    const $ = cheerio.load(res.data)
                    videoUrl = $('#html5video_base a').attr('href') || $('#html5video_base div a').attr('href') || res.data.match(/html5video\.setVideoUrlHigh\('([^']+)'\)/)?.[1]
                    title = $('meta[property="og:title"]').attr('content') || title
                }
            }
            if (!videoUrl) {
                const TEMP_DIR = path.join(process.cwd(), 'tmp')
                if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
                const finalPath = path.join(TEMP_DIR, `xn_${Date.now()}.mp4`)
                await execAsync(`yt-dlp -f "best[ext=mp4]/best" -o "${finalPath}" "${link}"`, { timeout: 120000 })
                if (fs.existsSync(finalPath)) {
                    await conn.sendFile(m.chat, finalPath, 'xnxx.mp4', `✅ *Auto DL: XNXX*\n\n📌 *Título:* ${title}`, m, false, { asDocument: chat?.useDocument })
                    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
                    m.react(done)
                    return true
                }
            }
            if (!videoUrl) throw new Error('Falha ao extrair vídeo do XNXX.')
            await conn.sendFile(m.chat, videoUrl, (title || 'xnxx') + '.mp4', `✅ *Auto DL: XNXX*\n\n📌 *Título:* ${title}`, m, false, { asDocument: chat?.useDocument })
            m.react(done)
        } catch (e) {
            console.error('AutoDL XNXX Error:', e.message)
            m.react('❌')
            m.reply(`❎ Erro ao baixar XNXX: ${e.message}`)
        }
    }

    return found
}
