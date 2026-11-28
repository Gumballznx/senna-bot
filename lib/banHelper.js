export async function resolveUserJidAliases(conn, rawJid, chatJid) {
    const targets = new Set()
    // Guarda só o identificador LIMPO (sem o ":0" do aparelho, que o Baileys devolve no mapa LID↔número)
    const add = (j) => {
        if (!j || typeof j !== 'string') return
        targets.add(j.replace(/:\d+@/, '@'))
    }

    add(rawJid)
    try {
        if (typeof conn?.getJid === 'function') {
            const resolved = await conn.getJid(rawJid, chatJid)
            add(resolved)
        }
        const lidMap = conn?.signalRepository?.lidMapping
        for (const j of [...targets]) {
            if (j.endsWith('@s.whatsapp.net') && typeof lidMap?.getLIDForPN === 'function') {
                add(await lidMap.getLIDForPN(j).catch(() => null))
            } else if (j.endsWith('@lid') && typeof lidMap?.getPNForLID === 'function') {
                add(await lidMap.getPNForLID(j).catch(() => null))
            }
        }
        if (conn?.isLid instanceof Map) {
            for (const [lid, pn] of conn.isLid.entries()) {
                if (targets.has(lid) || targets.has(pn)) {
                    add(lid)
                    add(pn)
                }
            }
        }
    } catch {}

    return targets
}

export async function setUserBanned(conn, rawJid, chatJid, banned) {
    const targets = await resolveUserJidAliases(conn, rawJid, chatJid)
    for (const targetJid of targets) {
        if (typeof global.db.data.users[targetJid] === 'undefined') {
            global.db.data.users[targetJid] = { banned }
        } else {
            global.db.data.users[targetJid].banned = banned
        }
    }
    const displayJid = [...targets].find(j => j.endsWith('@s.whatsapp.net')) || rawJid
    return { targets: [...targets], displayJid }
}
