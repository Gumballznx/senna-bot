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

/**
 * Bane/desbane e diz se REALMENTE mudou alguma coisa.
 * Retorna { targets, displayJid, wasBanned, changed }:
 *  - wasBanned: estava banido ANTES (qualquer variação do identificador conta, igual ao handler)
 *  - changed:   true se o estado mudou (ban: não estava banido · unban: estava banido)
 */
export async function setUserBanned(conn, rawJid, chatJid, banned) {
    const targets = await resolveUserJidAliases(conn, rawJid, chatJid)
    const users = global.db.data.users

    // Inclui chaves antigas do banco que ficaram com ":aparelho" (de antes da correção) e são o mesmo usuário
    const keys = new Set(targets)
    for (const k of Object.keys(users)) {
        if (targets.has(k.replace(/:\d+@/, '@'))) keys.add(k)
    }

    const wasBanned = [...keys].some(j => users[j]?.banned === true)

    if (banned) {
        // sempre deixa todas as variações iguais (sincroniza), mesmo que já estivesse banido
        for (const j of keys) {
            if (typeof users[j] === 'undefined') users[j] = { banned: true }
            else users[j].banned = true
        }
    } else if (wasBanned) {
        // só mexe no banco se havia algo para desbanir (não cria registros à toa)
        for (const j of keys) {
            if (users[j]) users[j].banned = false
        }
    }

    const displayJid = [...targets].find(j => j.endsWith('@s.whatsapp.net')) || String(rawJid).replace(/:\d+@/, '@')
    return { targets: [...targets], displayJid, wasBanned, changed: banned ? !wasBanned : wasBanned }
}
