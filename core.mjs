// Pure helpers: no SillyTavern imports, so tests can run them directly in Node.
export const KEY = 'worldinfo_tracker';

export const entryKey = (world, uid) => JSON.stringify([String(world), String(uid)]);

function escapeRegex(text) {
    return text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Mirrors parseRegexFromString in world-info.js: "/pattern/flags" keys are regexes.
export function parseKeyRegex(input) {
    const match = String(input).match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try { return new RegExp(pattern, flags); } catch { return null; }
}

// Mirrors WorldInfoBuffer.matchKeys. Entry-level null settings fall back to the global ones.
export function keyMatches(haystack, key, entry, globals) {
    const regex = parseKeyRegex(key);
    if (regex) return regex.test(haystack);
    const caseSensitive = entry.caseSensitive ?? globals.caseSensitive;
    const text = caseSensitive ? haystack : haystack.toLowerCase();
    const needle = caseSensitive ? key : key.toLowerCase();
    const wholeWords = entry.matchWholeWords ?? globals.matchWholeWords;
    if (wholeWords && needle.split(/\s+/).length <= 1) {
        return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(text);
    }
    return text.includes(needle);
}

// Rebuilds the chat lines ST scans for World Info (newest first), as in Generate().
// Prompt-only regex scripts are not applied, so results are an estimate.
export function scanMessages(chat, { type = '', includeNames = true } = {}) {
    const core = (Array.isArray(chat) ? chat : []).filter(x => x && !x.is_system);
    if (type === 'swipe') core.pop();
    return core.map(x => includeNames ? `${x.name}: ${x.mes ?? ''}` : String(x.mes ?? '')).reverse();
}

export function scanText(messages, entry, globals) {
    const depth = Math.max(0, Number(entry.scanDepth ?? globals.depth) || 0);
    return messages.slice(0, depth).map(x => x.trim()).join('\n');
}

const keyList = value => (Array.isArray(value) ? value : []).map(x => String(x).trim()).filter(Boolean);

/**
 * Explains why an activated entry fired.
 * @returns {{ mode: 'constant'|'vectorized'|'keyword', primary: string[], secondary: string[], source: 'chat'|'recursion'|'unknown'|null }}
 */
export function explainEntry(entry, { messages, recursion = '', globals, substitute = x => x }) {
    if (entry.constant) return { mode: 'constant', primary: [], secondary: [], source: null };
    const chatText = scanText(messages, entry, globals);
    const find = (keys, text) => keyList(keys).filter(key => {
        const resolved = String(substitute(key) ?? '').trim();
        return resolved && keyMatches(text, resolved, entry, globals);
    });
    let primary = find(entry.key, chatText), source = 'chat';
    if (!primary.length && recursion) {
        primary = find(entry.key, recursion);
        source = primary.length ? 'recursion' : 'unknown';
    } else if (!primary.length) source = 'unknown';
    const secondary = find(entry.keysecondary, source === 'recursion' ? recursion : chatText);
    return { mode: entry.vectorized ? 'vectorized' : 'keyword', primary, secondary, source };
}

// Other activated entries' bodies, for entries that fired through recursion.
export function recursionText(entries, self) {
    return entries.filter(x => x !== self && !x.preventRecursion).map(x => String(x.content ?? '')).join('\n');
}

/**
 * Chat-only replacements: { world, uid, book, copyUid } means "in this chat, use the copy
 * book/copyUid instead of world/uid". The original is hidden only while its copy exists.
 * Splices in place because ST keeps using the emitted arrays.
 */
export function applyReplacements(payload, replaced) {
    if (!payload || !Array.isArray(replaced) || !replaced.length) return 0;
    const lists = ['globalLore', 'characterLore', 'chatLore', 'personaLore'].map(k => payload[k]).filter(Array.isArray);
    const present = new Set(lists.flat().map(e => entryKey(e.world, e.uid)));
    const hidden = new Set(replaced.filter(r => present.has(entryKey(r.book, r.copyUid))).map(r => entryKey(r.world, r.uid)));
    let removed = 0;
    for (const list of lists) {
        const kept = list.filter(e => !hidden.has(entryKey(e.world, e.uid)));
        removed += list.length - kept.length;
        if (kept.length !== list.length) list.splice(0, list.length, ...kept);
    }
    return removed;
}

/**
 * Chat-only ON/OFF: toggles maps entryKey -> true (on) / false (off). Entries are
 * cloned, never edited, so ST's cached book data stays untouched. Splices in place.
 */
export function applyToggles(payload, toggles) {
    if (!payload || !toggles || !Object.keys(toggles).length) return 0;
    let changed = 0;
    for (const k of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const list = payload[k];
        if (!Array.isArray(list)) continue;
        const next = list.map(entry => {
            const on = toggles[entryKey(entry.world, entry.uid)];
            if (typeof on !== 'boolean' || on === !entry.disable) return entry;
            changed++;
            return { ...entry, disable: !on };
        });
        list.splice(0, list.length, ...next);
    }
    return changed;
}

export function freeUid(data) {
    const entries = data?.entries || {};
    for (let uid = 0; uid < 1_000_000; uid++) if (!(uid in entries)) return uid;
    return null;
}

// The copy keeps every setting of the source entry. Its ON/OFF follows what this chat
// actually used (e.g. a Switchboard override), not the raw file flag.
export function buildCopy(raw, effective, uid, edits) {
    const { world: _world, ...source } = structuredClone(raw);
    return { ...source, uid, displayIndex: uid, disable: Boolean(effective?.disable ?? raw.disable), ...edits };
}

export function chatBookName(chatId, exists) {
    const base = `이 방 전용 · ${chatId}`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100);
    let name = base;
    for (let n = 2; exists(name); n++) name = `${base} (${n})`;
    return name;
}

// Keys are comma-separated; a /regex/ key may itself contain commas.
export function formatKeys(keys) {
    return keyList(keys).join(', ');
}
export function parseKeys(text) {
    const keys = [];
    let pending = '';
    for (const piece of String(text ?? '').split(/[,\n]/)) {
        pending = pending ? `${pending},${piece}` : piece;
        const trimmed = pending.trim();
        // Keep joining while an opened "/..." has not closed into a valid regex yet.
        if (trimmed.startsWith('/') && !parseKeyRegex(trimmed)) continue;
        if (trimmed) keys.push(trimmed);
        pending = '';
    }
    if (pending.trim()) keys.push(...pending.split(',').map(x => x.trim()).filter(Boolean));
    return keys;
}

export function countOccurrences(text, needle) {
    if (!needle) return 0;
    return String(text).split(needle).length - 1;
}

// ---------- AI ----------
export const AI_SYSTEM_PROMPT = `You maintain the World Info (lorebook) of an ongoing SillyTavern roleplay. The user asks you to add or update entries.

Reply with JSON only, no other text, in exactly this shape:
{"proposals":[
 {"action":"create","comment":"title","keys":["keyword"],"constant":false,"content":"entry text","reason":"why"},
 {"action":"update","world":"book name","uid":12,"comment":"title","keys":["keyword"],"content":"complete new entry text","reason":"why"}
]}

Rules:
- "update" may only target an entry shown in full under ENTRY DETAILS, using its exact world and uid. Give the complete new content, not a diff. Keep everything that is still true; change only what the request or the story requires.
- Prefer updating an existing entry over creating a near-duplicate.
- Match the language, tone and formatting of the existing entries (headings, bullet style).
- For something that has not happened yet in the story, state its trigger condition explicitly so it is never treated as current fact.
- "keys": names and words that appear in chat when the entry matters. Use "constant": true only for rules that must always apply.
- "reason": one short sentence in the language of the user's request.
- At most 5 proposals. If nothing should change, return {"proposals":[]}.`;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Picks entries whose full text goes to the AI: those named by the request first, then
 * the ones active in the last reply, within a character budget.
 */
export function pickDetails(entries, { request = '', activeKeys = new Set(), budget = 24000, globals = { caseSensitive: false, matchWholeWords: false } } = {}) {
    const named = e => {
        const title = String(e.comment || '').trim();
        if (title && request.toLowerCase().includes(title.toLowerCase())) return true;
        return keyList(e.key).some(k => keyMatches(request, k, e, globals));
    };
    const ranked = [...entries.filter(named), ...entries.filter(e => activeKeys.has(entryKey(e.world, e.uid)))];
    const picked = [], seen = new Set();
    let used = 0;
    for (const e of ranked) {
        const k = entryKey(e.world, e.uid), size = String(e.content || '').length;
        if (seen.has(k) || used + size > budget) continue;
        seen.add(k); picked.push(e); used += size;
    }
    return picked;
}

export const AUTO_REQUEST = `Automatic check (no user request). Read RECENT CHAT and propose changes only for lasting facts: something in the lorebook that is now outdated (status, ranks, timers, locations, relationships, injuries, possessions, cleared floors...), or an important new lasting fact the lorebook lacks. Ignore momentary actions, moods and dialogue. If nothing needs to change, return {"proposals":[]}. Write "reason" in the main language of the chat.`;

export function buildAiMessages({ request, entries, details, chatLines = [], extra = '' }) {
    const list = entries.map(e => `${e.world} | ${e.uid} | ${String(e.comment || '').replace(/\s+/g, ' ')} | ${keyList(e.key).join(', ')} | ${e.constant ? 'constant' : 'keyword'}${e.disable ? ', off' : ''}`);
    const full = details.map(e => `### [${e.world} #${e.uid}] ${e.comment || ''}\n${e.content || ''}`);
    const user = [
        '## ENTRY LIST (world | uid | title | keys | type)', list.join('\n') || '(none)',
        '## ENTRY DETAILS', full.join('\n\n') || '(none)',
        '## RECENT CHAT (oldest first)', chatLines.join('\n') || '(none)',
        '## REQUEST', request,
    ].join('\n\n');
    const system = extra.trim() ? `${AI_SYSTEM_PROMPT}\n\nAdditional instructions from the user (follow them unless they break the JSON format):\n${extra.trim()}` : AI_SYSTEM_PROMPT;
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function recentChatLines(chat, turns, maxChars = 2000) {
    return (Array.isArray(chat) ? chat : []).filter(x => x && !x.is_system).slice(-Math.max(0, turns))
        .map(x => `${x.name}: ${clip(String(x.mes ?? '').trim(), maxChars)}`);
}

/** Reads the model's JSON; tolerates code fences and stray text around it. */
export function parseProposals(text) {
    const raw = String(text ?? '').replace(/```(?:json)?/gi, '');
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 응답에서 JSON을 찾지 못했어요.');
    let data;
    try { data = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('AI 응답의 JSON 형식이 깨져 있어요.'); }
    const list = Array.isArray(data) ? data : data?.proposals;
    if (!Array.isArray(list)) throw new Error('AI 응답에 proposals 목록이 없어요.');
    return list.filter(p => p && (p.action === 'create' || p.action === 'update') && typeof p.content === 'string' && p.content.trim())
        .map(p => ({
            action: p.action,
            world: p.action === 'update' ? String(p.world ?? '') : '',
            uid: p.action === 'update' ? p.uid : null,
            comment: String(p.comment ?? '').trim(),
            key: keyList(p.keys ?? p.key),
            constant: Boolean(p.constant),
            content: p.content,
            reason: String(p.reason ?? '').trim(),
        }));
}

/** Line diff (LCS) for showing what an update changes. */
export function lineDiff(before, after) {
    const a = String(before ?? '').split('\n'), b = String(after ?? '').split('\n');
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: a[i++] });
        else out.push({ type: 'add', text: b[j++] });
    }
    while (i < n) out.push({ type: 'del', text: a[i++] });
    while (j < m) out.push({ type: 'add', text: b[j++] });
    return out;
}
