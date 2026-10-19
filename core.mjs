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

// Keys are comma-separated; once any key holds a comma (regex), one key per line.
export function formatKeys(keys) {
    const list = keyList(keys);
    return list.some(x => x.includes(',')) ? list.join('\n') : list.join(', ');
}
export function parseKeys(text) {
    const value = String(text ?? '');
    return value.split(value.includes('\n') ? /\n/ : /,/).map(x => x.trim()).filter(Boolean);
}

export function countOccurrences(text, needle) {
    if (!needle) return 0;
    return String(text).split(needle).length - 1;
}
