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
// The reply shape is what the extension reads, so this part is locked. Everything else
// (the rules below) can be edited in the settings tab.
export const FORMAT_LOCKED = `Reply with JSON only, no other text, in exactly this shape:
{"vars":[{"name":"exact variable name","value":"new value","reason":"why"}],
 "proposals":[
 {"action":"update","world":"book name","uid":12,"edits":[{"find":"exact text from the entry","replace":"new text"}],"vars":[{"name":"new variable","value":"its current value"}],"reason":"why"},
 {"action":"create","comment":"title","keys":["keyword"],"constant":false,"content":"entry text","reason":"why"}
]}

Format notes:
- "edits": each "find" is copied character for character from that entry and is replaced everywhere it occurs. Give "content" (the complete new text) instead of "edits" only for a rewrite of most of the entry. "comment" and "keys" are optional on an update.
- Top-level "vars" sets variables by their exact names. A proposal's own "vars" lists the variables its edits introduce, with their current values.
- If nothing should change, return {"vars":[],"proposals":[]}.`;

// Pre-filled into the "추가 지시" setting once; the user can edit or delete it.
export const DEFAULT_EXTRA_PROMPT = `## Concrete Concepts & Naming

- Prefer concrete, recognizable concepts over abstract, symbolic, or elaborate inventions. A reader should be able to picture what something is and grasp what it does.
- For creatures, abilities, items, and phenomena, default to familiar genre conventions unless the setting calls for something else.
- Give every new element a clear identity: what it looks like, what it does, and where its limits or costs lie.
- Name things plainly and descriptively (e.g., "Iron Golem", "Frost Wolf", "Healing"). Avoid ornate titles built from mystical, cosmic, or philosophical terms (e.g., "Eternal Void-Flame Sovereign of Severed Fate"), and don't stack grandiose adjectives or invented terminology.
- Originality comes from distinctive behavior, uses, limits, and circumstances, never from obscurity or novelty for its own sake.
- Abstract or unusual concepts are fine when the established setting, a character, or the story genuinely calls for them.
- Do not turn ordinary things into extraordinary ones just to create mystery, grandeur, or importance.`;

// Editable rules. Defaults are used until the user changes them in the settings tab.
export const DEFAULT_ASK_RULES = `You maintain the World Info (lorebook) of an ongoing SillyTavern roleplay. The user asks you to add or update entries.
The user is talking to you, the lorebook maintainer, not to the roleplay: every request is about the lorebook. "Enter", "write", "put in", "update" or "recalculate" X means change the lorebook so it holds X (e.g. recompute a timer from the current in-story date in RECENT CHAT and set the result).

Rules:
- "update" may only target an entry shown in full under ENTRY DETAILS, using its exact world and uid.
- Keep each "find" short but unambiguous.
- Prefer updating an existing entry over creating a near-duplicate.
- Match the language, tone and formatting of the existing entries (headings, bullet style).
- For something that has not happened yet in the story, state its trigger condition explicitly so it is never treated as current fact.
- "keys": names and words that appear in chat when the entry matters. "constant": true only for rules that must always apply.
- "reason": one short sentence in the language of the chat.
- At most 5 proposals.

Variables: values that change as the story goes on (dates, timers, counts, ranks, affiliations, statuses) can live in chat variables. An entry reads one with {{getvar::name}}; the value is stored per chat, not in the entry.
- Top-level "vars" sets variables already listed under CURRENT VALUES (exact names only). Never invent a variable there, and never write such a value into entry text.
- To turn a changing value inside an entry into a variable: in that entry's "update", replace the value in "edits" with {{getvar::name}} and list the variable in that update's "vars" with its current value. Prefer an absolute date over a countdown when the chat shows today's date.`;

export const DEFAULT_TRACK_RULES = `You maintain the World Info (lorebook) of an ongoing SillyTavern roleplay. Read NEW CHAT and report only lasting changes the lorebook should reflect. Nobody is talking to you: answer with the JSON only.

What to report (only what NEW CHAT actually establishes, never plans, rumors or guesses):
1. Value changes: CURRENT VALUES lists chat variables that entries read with {{getvar::name}}. If NEW CHAT shows one has a different value now, put its new value in top-level "vars", in the same format as the old value.
2. Stale information: an entry in ENTRY DETAILS states something NEW CHAT has made untrue (e.g. "has not happened yet", "does not exist yet", an old affiliation or status). Propose an "update" with "edits" that fix only that wording. If the changing fact is a value, turn it into a variable (see Variables).
3. New lasting facts: a named character, place, faction, item, creature or rule that matters later and has no entry in ENTRY LIST (check titles and keys first). Propose a "create". Skip scenery, moods, one-off actions and anything already covered.
Prefer nothing over noise.

Rules:
- "update" may only target an entry shown in full under ENTRY DETAILS, using its exact world and uid.
- Keep each "find" short but unambiguous.
- Prefer updating an existing entry over creating a near-duplicate.
- Match the language, tone and formatting of the existing entries (headings, bullet style).
- For something that has not happened yet in the story, state its trigger condition explicitly so it is never treated as current fact.
- "keys": names and words that appear in chat when the entry matters. "constant": true only for rules that must always apply.
- "reason": one short sentence in the language of the chat.
- At most 5 proposals.

Variables: values that change as the story goes on (dates, timers, counts, ranks, affiliations, statuses) can live in chat variables. An entry reads one with {{getvar::name}}; the value is stored per chat, not in the entry.
- Top-level "vars" sets variables already listed under CURRENT VALUES (exact names only). Never invent a variable there, and never write such a value into entry text.
- To turn a changing value inside an entry into a variable: in that entry's "update", replace the value in "edits" with {{getvar::name}} and list the variable in that update's "vars" with its current value. Prefer an absolute date over a countdown when the chat shows today's date.`;

/** The editable rules, the locked reply format, then the user's extra instructions. */
export function buildSystemPrompt(rules, extra = '') {
    const body = `${String(rules ?? '').trim()}\n\n${FORMAT_LOCKED}`.trim();
    return String(extra ?? '').trim()
        ? `${body}\n\nAdditional instructions from the user (follow them unless they break the JSON format):\n${extra.trim()}` : body;
}
export const AI_SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_ASK_RULES);
export const TRACK_SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_TRACK_RULES);

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Picks entries whose full text goes to the AI, within a character budget: those named in
 * the request, then those active in the last reply. Only when neither finds anything do the
 * ON constant entries go in. Bodies are the costly part of a request, so this stays lean.
 */
export function pickDetails(entries, { request = '', activeKeys = new Set(), targets = null, budget = 12000, globals = { caseSensitive: false, matchWholeWords: false } } = {}) {
    // Entries the user picked are sent alone, whatever their size.
    if (targets?.size) return entries.filter(e => targets.has(entryKey(e.world, e.uid)));
    const named = e => {
        const title = String(e.comment || '').trim();
        if (title && request.toLowerCase().includes(title.toLowerCase())) return true;
        return keyList(e.key).some(k => keyMatches(request, k, e, globals));
    };
    let ranked = [...entries.filter(named), ...entries.filter(e => activeKeys.has(entryKey(e.world, e.uid)))];
    if (!ranked.length) ranked = entries.filter(e => e.constant && !e.disable);
    const picked = [], seen = new Set();
    let used = 0;
    for (const e of ranked) {
        const k = entryKey(e.world, e.uid), size = String(e.content || '').length;
        if (seen.has(k) || used + size > budget) continue;
        seen.add(k); picked.push(e); used += size;
    }
    return picked;
}

const entryList = entries => entries.map(e => `${e.world} | ${e.uid} | ${String(e.comment || '').replace(/\s+/g, ' ')} | ${keyList(e.key).slice(0, 4).join(', ')} | ${e.constant ? 'constant' : 'keyword'}${e.disable ? ', off' : ''}`);
const entryBodies = details => details.map(e => `### [${e.world} #${e.uid}] ${e.comment || ''}\n${e.content || ''}`);
const valueList = vars => Object.entries(vars || {}).map(([k, v]) => `${k} = ${v === '' ? '(not set)' : v}`);
export function buildAiMessages({ request, entries, details, chatLines = [], vars = {}, rules = DEFAULT_ASK_RULES, extra = '' }) {
    const user = [
        '## CURRENT VALUES (variable = value)', valueList(vars).join('\n') || '(none)',
        '## ENTRY LIST (world | uid | title | keys | type)', entryList(entries).join('\n') || '(none)',
        '## ENTRY DETAILS', entryBodies(details).join('\n\n') || '(none)',
        '## RECENT CHAT (oldest first)', chatLines.join('\n') || '(none)',
        '## REQUEST', request,
    ].join('\n\n');
    return [{ role: 'system', content: buildSystemPrompt(rules, extra) }, { role: 'user', content: user }];
}

export function buildTrackMessages({ lines, vars = {}, entries, details, rules = DEFAULT_TRACK_RULES, extra = '', part = null }) {
    const user = [
        '## CURRENT VALUES (variable = value)', valueList(vars).join('\n') || '(none)',
        '## ENTRY LIST (world | uid | title | keys | type)', entryList(entries).join('\n') || '(none)',
        '## ENTRY DETAILS', entryBodies(details).join('\n\n') || '(none)',
        `## NEW CHAT (oldest first)${part ? ` - part ${part.i} of ${part.n}` : ''}`, lines.join('\n\n') || '(none)',
    ].join('\n\n');
    return [{ role: 'system', content: buildSystemPrompt(rules, extra) }, { role: 'user', content: user }];
}

export function recentChatLines(chat, turns, maxChars = 2000) {
    return (Array.isArray(chat) ? chat : []).filter(x => x && !x.is_system).slice(-Math.max(0, turns))
        .map(x => `${x.name}: ${clip(String(x.mes ?? '').trim(), maxChars)}`);
}

// Variable names go inside {{getvar::name}}, so they cannot hold braces, "::" or line breaks.
export function validVarName(name) {
    const n = String(name ?? '').trim();
    return n.length >= 1 && n.length <= 60 && !/[{}\r\n]|::/.test(n) ? n : '';
}
export function normalizeVars(list) {
    const seen = new Set(), out = [];
    for (const v of Array.isArray(list) ? list : []) {
        const name = validVarName(v?.name);
        if (!name || seen.has(name) || v.value === undefined || v.value === null || typeof v.value === 'object') continue;
        seen.add(name);
        out.push({ name, value: String(v.value).trim().slice(0, 300), reason: String(v.reason ?? '').trim() });
    }
    return out;
}

/** Reads the model's JSON; tolerates code fences and stray text around it. */
export function parseAiResult(text) {
    const raw = String(text ?? '').replace(/```(?:json)?/gi, '');
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('AI 응답에서 JSON을 찾지 못했어요. 응답이 중간에 잘렸을 수 있어요. 생각(추론)하는 모델은 생각에도 토큰을 써서, 설정 탭의 최대 토큰을 늘리면 해결될 때가 많아요.');
    }
    let data;
    try { data = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('AI 응답의 JSON 형식이 깨져 있어요.'); }
    const list = Array.isArray(data) ? data : data?.proposals;
    if (!Array.isArray(list)) throw new Error('AI 응답에 proposals 목록이 없어요.');
    const editsOf = p => (Array.isArray(p.edits) ? p.edits : [])
        .filter(x => x && typeof x.find === 'string' && x.find && typeof x.replace === 'string')
        .map(x => ({ find: x.find, replace: x.replace }));
    const hasContent = p => typeof p.content === 'string' && p.content.trim();
    const proposals = list.filter(p => p && (p.action === 'create' ? hasContent(p) : p.action === 'update' && (hasContent(p) || editsOf(p).length)))
        .map(p => ({
            action: p.action,
            world: p.action === 'update' ? String(p.world ?? '') : '',
            uid: p.action === 'update' ? p.uid : null,
            comment: String(p.comment ?? '').trim(),
            key: keyList(p.keys ?? p.key),
            constant: Boolean(p.constant),
            content: hasContent(p) ? p.content : null,
            edits: hasContent(p) ? [] : editsOf(p),
            vars: normalizeVars(p.vars),
            reason: String(p.reason ?? '').trim(),
        }));
    return { vars: Array.isArray(data) ? [] : normalizeVars(data?.vars), proposals };
}
export const parseProposals = text => parseAiResult(text).proposals;

/** Applies find/replace edits; a find that is not in the text makes the whole update fail. */
export function applyEdits(text, edits) {
    let content = String(text ?? '');
    const missing = [];
    for (const { find, replace } of edits) {
        if (!content.includes(find)) { missing.push(find); continue; }
        content = content.split(find).join(replace);
    }
    return { content, missing };
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

// ---------- Variables ----------
const GETVAR = /{{getvar::([^}]+)}}/gi;

/** Which entries read which chat variables: name -> [entry titles]. */
export function findVarRefs(entries) {
    const refs = new Map();
    for (const e of entries) {
        const title = String(e.comment || '').trim() || `엔트리 ${e.uid}`;
        for (const m of String(e.content ?? '').matchAll(GETVAR)) {
            const name = m[1].trim();
            if (!name) continue;
            const titles = refs.get(name) ?? [];
            if (!titles.includes(title)) titles.push(title);
            refs.set(name, titles);
        }
    }
    return refs;
}

// ---------- Auto tracking: bookmark, ranges, chunks ----------
/**
 * Hidden messages (a summary extension hides old ones) keep their text and only set
 * is_system, so they stay readable. Real system/narrator lines carry extra.type.
 */
export function isReadable(m) {
    return Boolean(m) && typeof m.mes === 'string' && (!m.is_system || !m.extra?.type);
}
const isTurn = m => isReadable(m) && !m.is_user;

export const messageSig = m => (m ? `${m.send_date ?? ''}|${m.name ?? ''}|${m.is_user ? 1 : 0}` : '');

/**
 * Where the bookmark (number of chat items already read) is now. Deleting or inserting
 * earlier messages moves it by looking for the message it was placed after.
 * @returns {number|null} null when there is no bookmark yet.
 */
export function relocateBookmark(chat, at, sig) {
    const list = Array.isArray(chat) ? chat : [];
    if (!Number.isInteger(at) || at < 0) return null;
    if (at === 0) return 0;
    if (at <= list.length && (!sig || messageSig(list[at - 1]) === sig)) return at;
    if (sig) {
        const i = list.findIndex(m => messageSig(m) === sig);
        if (i >= 0) return i + 1;
    }
    return Math.min(at, list.length);
}

/**
 * The part of the chat to read next. A "turn" is a character message.
 * Automatic: once `every` turns plus `hold` newest turns have piled up behind the
 * bookmark, read the first `every`; the newest turns wait so a swipe cannot leak in.
 * Manual (force): read everything after the bookmark (at most 2x `every` turns, newest);
 * with no bookmark, the latest `every` turns.
 */
export function pickRange(chat, at, { every, hold = 2, force = false } = {}) {
    const list = Array.isArray(chat) ? chat : [];
    const from = Number.isInteger(at) && at > 0 ? Math.min(at, list.length) : 0;
    const turns = [];
    for (let i = from; i < list.length; i++) if (isTurn(list[i])) turns.push(i);
    let start = from, end;
    if (!force) {
        if (at === null || at === undefined || turns.length < every + hold) return null;
        end = turns[every - 1] + 1;
    } else {
        end = list.length;
        if (at === null || at === undefined) {
            const all = [];
            for (let i = 0; i < list.length; i++) if (isTurn(list[i])) all.push(i);
            if (!all.length) return null;
            start = all[Math.max(0, all.length - every)];
        } else {
            if (!turns.length) return null;
            const cap = every * 2;
            if (turns.length > cap) start = turns[turns.length - cap];
        }
        // Start at the user message that prompted the first turn, if there is one.
        for (let j = start - 1; j >= 0; j--) {
            if (!isReadable(list[j])) continue;
            if (list[j].is_user && j >= from) start = j;
            break;
        }
    }
    const messages = [];
    for (let i = start; i < end; i++) if (isReadable(list[i])) messages.push({ index: i, name: list[i].name ?? '', is_user: Boolean(list[i].is_user), mes: list[i].mes });
    return { start, end, messages, turns: messages.filter(m => !m.is_user).length };
}

/** For the status line: character turns piled up behind the bookmark. */
export function pendingTurns(chat, at) {
    const list = Array.isArray(chat) ? chat : [];
    let n = 0;
    for (let i = Number.isInteger(at) && at > 0 ? Math.min(at, list.length) : 0; i < list.length; i++) if (isTurn(list[i])) n++;
    return n;
}

export const formatLines = (messages, maxChars = 4000) => messages.map(m => `${m.name}: ${clip(String(m.mes).trim(), maxChars)}`);

export function parseTagList(text) {
    return [...new Set(String(text ?? '').split(/[,\s]+/).map(x => x.replace(/^<|>$/g, '').trim()).filter(x => /^[\w-]{1,30}$/.test(x)))];
}

/**
 * Status blocks like <Status>…</Status> repeat in every message. Only the newest one is
 * kept (it holds the current state); older copies are cut to save tokens.
 */
export function thinTagBlocks(lines, tags) {
    const out = [...lines];
    for (const tag of tags) {
        const re = () => new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi');
        let last = -1;
        out.forEach((line, i) => { if (re().test(line)) last = i; });
        if (last < 0) continue;
        out.forEach((line, i) => {
            if (i > last) return;
            let kept = 0;
            const total = (line.match(re()) || []).length;
            out[i] = line.replace(re(), block => (i === last && ++kept === total ? block : '')).replace(/\n{3,}/g, '\n\n');
        });
    }
    return out;
}

/** Splits lines into parts of at most maxChars (a single long line stays whole). */
export function splitParts(lines, maxChars) {
    const parts = [];
    let cur = [], size = 0;
    for (const line of lines) {
        if (cur.length && size + line.length > maxChars) { parts.push(cur); cur = []; size = 0; }
        cur.push(line); size += line.length;
    }
    if (cur.length) parts.push(cur);
    return parts;
}

/** Entry bodies for the tracker: those named in the new chat, then ON constant entries. */
export function pickTrackDetails(entries, text, { budget = 16000, globals = { caseSensitive: false, matchWholeWords: false } } = {}) {
    const haystack = String(text ?? '');
    const named = e => {
        const title = String(e.comment || '').trim();
        if (title && haystack.toLowerCase().includes(title.toLowerCase())) return true;
        return keyList(e.key).some(k => keyMatches(haystack, k, e, globals));
    };
    const ranked = [...entries.filter(named), ...entries.filter(e => e.constant && !e.disable)];
    const picked = [], seen = new Set();
    let used = 0;
    for (const e of ranked) {
        const k = entryKey(e.world, e.uid), size = String(e.content || '').length;
        if (seen.has(k) || used + size > budget) continue;
        seen.add(k); picked.push(e); used += size;
    }
    return picked;
}
