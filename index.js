import { eventSource, event_types, isGenerating } from '../../../../script.js';
import {
    getSortedEntries, METADATA_KEY, newWorldInfoEntryTemplate,
    world_info_depth, world_info_case_sensitive, world_info_match_whole_words, world_info_include_names, world_info_recursive,
} from '../../../world-info.js';
import {
    KEY, entryKey, scanMessages, explainEntry, recursionText, applyReplacements, applyToggles,
    freeUid, buildCopy, chatBookName, formatKeys, parseKeys, countOccurrences,
    pickDetails, buildAiMessages, buildTrackMessages, recentChatLines, parseAiResult, lineDiff, applyEdits,
    DEFAULT_EXTRA_PROMPT, DEFAULT_ASK_RULES, DEFAULT_TRACK_RULES, FORMAT_LOCKED, validVarName, findVarRefs, messageSig, relocateBookmark, pickRange, pendingTurns, formatLines, parseTagList, thinTagBlocks, splitParts, pickTrackDetails,
} from './core.mjs';
import { POSITION_KEY, SIZE_KEY, DEFAULT_SIZE, normalizeSize, readSize, touchSize, readPosition, positionPixels, attachFloatingDrag } from './floating.mjs';

const TITLE = '월드인포 트래커';
const BACKUP_PREFIX = 'wit_backup_v1:';
const context = () => SillyTavern.getContext();
const hasActivationHook = Boolean(event_types.WORLD_INFO_ACTIVATED);
const modeIcons = { constant: '🔵', keyword: '🟢', vectorized: '🔗' };
const modeLabels = { constant: '상시', keyword: '키워드', vectorized: '벡터 검색' };

let active = false;
const subscriptions = [];
let panel, body, status, subtitle, launcher, badge, dialog, searchInput, detachDrag, toolbar, aiBox, aiInput, aiSend, aiMeta, aiTargetRow, setupBox, fillSetup;
let tab = 'active', search = '', busy = false;
let generation = null, result = { chat: '', phase: 'unknown', entries: [] };
let allEntries = [], allChat = '', allError = '', allToken = 0, refreshTimer;
const fileOn = new Map();
let savedPosition = null, previewPosition = null, floatingSize = DEFAULT_SIZE;
try { floatingSize = readSize(globalThis.localStorage); } catch {}
try { savedPosition = readPosition(globalThis.localStorage); } catch {}

function listen(name, handler) { if (!name) return; eventSource.on(name, handler); subscriptions.push([name, handler]); }
function notify(message, error = false) { globalThis.toastr?.[error ? 'error' : 'info']?.(message, TITLE); }
function settings() {
    const c = context();
    c.extensionSettings[KEY] ??= {};
    c.extensionSettings[KEY].showIcon ??= true;
    c.extensionSettings[KEY].profileId ??= '';
    c.extensionSettings[KEY].chatTurns ??= 10;
    c.extensionSettings[KEY].maxTokens ??= 16384;
    // 0.3.0 defaulted to 4096, too small once a thinking model spends tokens on reasoning.
    if (!c.extensionSettings[KEY].tokensMigrated) {
        if (c.extensionSettings[KEY].maxTokens === 4096) c.extensionSettings[KEY].maxTokens = 16384;
        c.extensionSettings[KEY].tokensMigrated = true;
    }
    // 0.5.0: automatic checks count character turns behind a bookmark. Older values counted
    // messages, so start from the new defaults (off, every 30 turns).
    if (!c.extensionSettings[KEY].trackMigrated) {
        c.extensionSettings[KEY].autoOn = false;
        c.extensionSettings[KEY].autoEvery = 30;
        c.extensionSettings[KEY].trackMigrated = true;
    }
    c.extensionSettings[KEY].autoOn ??= false;
    c.extensionSettings[KEY].autoEvery ??= 30;
    c.extensionSettings[KEY].trackTags ??= 'Status';
    c.extensionSettings[KEY].customPrompt ??= '';
    // null = use the built-in rules; a string = the user's own version.
    c.extensionSettings[KEY].askPrompt ??= null;
    c.extensionSettings[KEY].trackPrompt ??= null;
    // One-time: put the naming rule into the user's own instructions (kept if they already have some).
    if (!c.extensionSettings[KEY].namingSeeded) {
        const own = String(c.extensionSettings[KEY].customPrompt).trim();
        if (!own.includes('Concrete Concepts & Naming')) c.extensionSettings[KEY].customPrompt = own ? `${own}\n\n${DEFAULT_EXTRA_PROMPT}` : DEFAULT_EXTRA_PROMPT;
        c.extensionSettings[KEY].namingSeeded = true;
    }
    c.extensionSettings[KEY].thinking ??= 'min';
    // Background the AI reads along with the chat.
    c.extensionSettings[KEY].sendCard ??= true;
    c.extensionSettings[KEY].sendPersona ??= true;
    c.extensionSettings[KEY].sendNote ??= true;
    return c.extensionSettings[KEY];
}

function chatKey() {
    const c = context();
    const id = c.getCurrentChatId?.();
    if (id === undefined || id === null || id === '') return '';
    const owner = c.groupId != null ? ['group', c.groupId] : ['character', c.characters?.[c.characterId]?.avatar ?? c.characterId];
    return JSON.stringify([...owner, id]);
}
function chatState() {
    const saved = context().chatMetadata?.[KEY] || {};
    const replaced = Array.isArray(saved.replaced) ? saved.replaced.filter(r => r && r.world && r.book && r.uid != null && r.copyUid != null) : [];
    const toggles = {};
    for (const [k, v] of Object.entries(saved.toggles || {})) if (typeof v === 'boolean') toggles[k] = v;
    const proposals = Array.isArray(saved.proposals) ? saved.proposals.filter(p => p && p.id && typeof p.content === 'string') : [];
    // Auto tracking bookmark: chat items already read, and the signature of the last one.
    const trackAt = Number.isInteger(saved.trackAt) && saved.trackAt >= 0 ? saved.trackAt : null;
    const trackSig = typeof saved.trackSig === 'string' ? saved.trackSig : '';
    const trackLast = saved.trackLast && typeof saved.trackLast === 'object' ? saved.trackLast : null;
    const varLog = Array.isArray(saved.varLog) ? saved.varLog.filter(x => x && x.name).slice(0, 40) : [];
    // Variables this extension manages. A chat holds many others (presets, other tools) that it must not touch.
    const tracked = [...new Set((Array.isArray(saved.tracked) ? saved.tracked : []).map(validVarName).filter(Boolean))];
    return { replaced, toggles, proposals, trackAt, trackSig, trackLast, varLog, tracked };
}
async function writeChatState(update, key) {
    const c = context();
    if (key !== chatKey() || !c.chatMetadata) throw new Error('채팅이 바뀌어 저장하지 않았어요.');
    const next = chatState();
    update(next);
    c.chatMetadata[KEY] = next;
    await c.saveMetadata();
}

// Chat variables are SillyTavern's own ({{getvar::name}}), stored per chat in its metadata.
function chatVars() {
    const raw = context().chatMetadata?.variables, out = {};
    if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) out[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
}
const describeChanges = list => list.map(d => `${d.name} ${d.from ?? '없음'} → ${d.value ?? '삭제'}`).join(', ');
/** value null removes the variable. Returns the changes that actually happened. */
async function writeVars(changes, source, key = chatKey(), { track = false } = {}) {
    const c = context();
    if (!key || key !== chatKey() || !c.chatMetadata) throw new Error('채팅이 바뀌어 저장하지 않았어요.');
    const vars = (c.chatMetadata.variables ??= {}), before = chatVars(), next = chatState(), applied = [];
    let trackChanged = false;
    for (const change of changes) {
        const name = validVarName(change.name);
        if (!name) continue;
        const from = Object.hasOwn(before, name) ? before[name] : null;
        const to = change.value === null || change.value === undefined ? null : String(change.value);
        // Managed variables: the ones the user or a proposal sets here, minus the ones deleted here.
        if (to === null) next.tracked = next.tracked.filter(n => n !== name);
        else if (track && !next.tracked.includes(name)) { next.tracked.push(name); trackChanged = true; }
        if (from === to) continue;
        if (to === null) { delete vars[name]; delete before[name]; } else { vars[name] = to; before[name] = to; }
        next.varLog.unshift({ name, from, to, time: Date.now(), source, reason: change.reason || '' });
        applied.push({ name, from, value: to, reason: change.reason || '' });
    }
    if (!applied.length && !trackChanged) return applied;
    next.varLog = next.varLog.slice(0, 40);
    c.chatMetadata[KEY] = next;
    await c.saveMetadata();
    return applied;
}
const RULE_DEFAULTS = { ask: DEFAULT_ASK_RULES, track: DEFAULT_TRACK_RULES };
const rulesFor = kind => (typeof settings()[`${kind}Prompt`] === 'string' ? settings()[`${kind}Prompt`] : RULE_DEFAULTS[kind]);
// The variables this extension manages: ones an entry reads with {{getvar::}} and ones added here.
// Everything else in the chat (preset variables, other tools) is left alone and never sent to the AI.
const trackedVarNames = entries => new Set([...chatState().tracked, ...findVarRefs(entries).keys()]);
function promptVars(entries) {
    const all = chatVars(), out = {};
    for (const name of trackedVarNames(entries)) out[name] = (all[name] ?? '').slice(0, 300);
    return out;
}

function worldNames() { return context().getWorldInfoNames?.() ?? []; }
function chatBook() {
    const name = context().chatMetadata?.[METADATA_KEY];
    return name && worldNames().includes(name) ? name : '';
}
function replacementOf(world, uid) {
    return chatState().replaced.find(r => r.book === world && String(r.copyUid) === String(uid));
}

// The chat-bound lorebook is SillyTavern's own "chat lore": it only loads in this chat.
async function ensureChatBook(key) {
    const existing = chatBook();
    if (existing) return existing;
    const c = context();
    const name = chatBookName(c.getCurrentChatId(), n => worldNames().includes(n));
    await c.saveWorldInfo(name, { entries: {} }, true);
    await c.updateWorldInfoList();
    if (!worldNames().includes(name)) throw new Error('이 방 전용 책을 만들지 못했어요.');
    if (key !== chatKey()) throw new Error('채팅이 바뀌어 연결하지 않았어요.');
    c.chatMetadata[METADATA_KEY] = name;
    await c.saveMetadata();
    document.querySelectorAll('.chat_lorebook_button').forEach(b => b.classList.add('world_set'));
    notify(`이 방 전용 책을 만들었어요: ${name}`);
    return name;
}

const backupStore = () => SillyTavern.libs?.localforage;
async function saveBackup(world, uid, raw) {
    try {
        await backupStore()?.setItem(`${BACKUP_PREFIX}${entryKey(world, uid)}`, {
            comment: raw.comment ?? '', key: raw.key ?? [], keysecondary: raw.keysecondary ?? [], content: raw.content ?? '', constant: Boolean(raw.constant), time: Date.now(),
        });
    } catch (error) { console.warn('[WorldInfo Tracker] Backup failed', error); }
}
async function readBackup(world, uid) {
    try { return await backupStore()?.getItem(`${BACKUP_PREFIX}${entryKey(world, uid)}`) ?? null; } catch { return null; }
}

function guard(key) {
    if (!key || key !== chatKey()) { notify('채팅을 먼저 열어주세요.'); return false; }
    if (isGenerating()) { notify('응답 생성이 끝난 뒤 저장해주세요.'); return false; }
    if (busy) return false;
    return true;
}
async function run(task) {
    busy = true; render();
    try { await task(); return true; } catch (error) { notify(error.message || String(error), true); return false; } finally { busy = false; render(); }
}

async function saveCopy(item, raw, edits, key) {
    const c = context();
    const book = await ensureChatBook(key);
    const data = structuredClone(await c.loadWorldInfo(book) ?? { entries: {} });
    data.entries ??= {};
    const uid = freeUid(data);
    if (uid === null) throw new Error('새 엔트리 번호를 정하지 못했어요.');
    data.entries[uid] = buildCopy(raw, item, uid, edits);
    await c.saveWorldInfo(book, data, true);
    await writeChatState(s => {
        s.replaced = s.replaced.filter(r => entryKey(r.world, r.uid) !== entryKey(item.world, item.uid));
        s.replaced.push({ world: item.world, uid: item.uid, book, copyUid: uid });
    }, key);
    c.reloadWorldInfoEditor?.(book);
    notify('이 방에만 저장했어요. 다른 채팅은 원본 그대로예요.');
}
async function saveInPlace(world, uid, edits) {
    const c = context();
    const data = structuredClone(await c.loadWorldInfo(world));
    const raw = data?.entries?.[uid];
    if (!raw) throw new Error('엔트리를 찾지 못했어요. 삭제됐을 수 있어요.');
    await saveBackup(world, uid, raw);
    data.entries[uid] = { ...raw, ...edits };
    await c.saveWorldInfo(world, data, true);
    c.reloadWorldInfoEditor?.(world);
    notify('저장했어요.');
}
async function addEntry(edits, key) {
    const c = context();
    const book = await ensureChatBook(key);
    const data = structuredClone(await c.loadWorldInfo(book) ?? { entries: {} });
    data.entries ??= {};
    const uid = freeUid(data);
    if (uid === null) throw new Error('새 엔트리 번호를 정하지 못했어요.');
    data.entries[uid] = { uid, ...structuredClone(newWorldInfoEntryTemplate), displayIndex: uid, ...edits };
    await c.saveWorldInfo(book, data, true);
    c.reloadWorldInfoEditor?.(book);
    notify('이 방 전용 책에 추가했어요.');
}
async function revertCopy(rep, key) {
    const c = context();
    const data = structuredClone(await c.loadWorldInfo(rep.book));
    if (data?.entries) {
        delete data.entries[rep.copyUid];
        await c.saveWorldInfo(rep.book, data, true);
    }
    await writeChatState(s => { s.replaced = s.replaced.filter(r => !(r.book === rep.book && String(r.copyUid) === String(rep.copyUid))); }, key);
    c.reloadWorldInfoEditor?.(rep.book);
    notify('원본으로 되돌렸어요. 다음 응답부터 원본이 들어가요.');
}

// ---------- activation capture ----------
function scanGlobals() {
    return { depth: world_info_depth, caseSensitive: world_info_case_sensitive, matchWholeWords: world_info_match_whole_words };
}
// Remember each chat's last activation so the count survives a reload or a chat switch.
const LAST_KEY = 'wit-last-activation', LAST_MAX = 30;
function readLastAll() {
    try { const all = JSON.parse(globalThis.localStorage?.getItem(LAST_KEY) || '{}'); return all && typeof all === 'object' ? all : {}; } catch { return {}; }
}
function saveLast(r) {
    if (!r.chat) return;
    const all = readLastAll();
    delete all[r.chat];
    all[r.chat] = r.entries;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - LAST_MAX))) delete all[k];
    try { globalThis.localStorage?.setItem(LAST_KEY, JSON.stringify(all)); } catch {}
}
function loadLast(chat) {
    const entries = chat ? readLastAll()[chat] : null;
    return Array.isArray(entries) ? { chat, phase: 'ready', entries, saved: true } : { chat: '', phase: 'unknown', entries: [] };
}
function setReady(entries) {
    result = { chat: generation.chat, phase: 'ready', entries };
    saveLast(result);
}

function capture(entries) {
    const c = context(), seen = new Set(), list = [];
    for (const entry of Array.from(entries || [])) {
        if (!entry || typeof entry.world !== 'string' || entry.uid == null) continue;
        const k = entryKey(entry.world, entry.uid);
        if (!seen.has(k)) { seen.add(k); list.push(entry); }
    }
    const messages = scanMessages(c.chat, { type: generation.type, includeNames: world_info_include_names });
    const globals = scanGlobals();
    const substitute = text => c.substituteParams?.(text) ?? text;
    return list.map(entry => ({
        world: entry.world, uid: entry.uid, comment: entry.comment, key: entry.key, keysecondary: entry.keysecondary,
        constant: entry.constant, vectorized: entry.vectorized, disable: entry.disable,
        why: explainEntry(entry, {
            messages, globals, substitute,
            recursion: world_info_recursive && !entry.excludeRecursion ? recursionText(list, entry) : '',
        }),
    }));
}

// ---------- UI ----------
function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, fn, cls = '', title = '') {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    return b;
}
// Keep typing inside our UI from reaching SillyTavern's global shortcuts (swipe etc.).
const isolateKeys = node => { for (const type of ['keydown', 'keyup', 'keypress']) node.addEventListener(type, e => e.stopPropagation()); };
function closeDialog() {
    const closing = dialog;
    dialog = null;
    if (closing) { closing.close(); closing.remove(); }
}
function modal(title) {
    closeDialog();
    const d = el('dialog', 'wit-dialog');
    const head = el('header', 'wit-modal-head');
    head.append(el('h3', '', title), button('닫기', closeDialog, 'wit-quiet'));
    d.append(head);
    isolateKeys(d);
    document.body.append(d);
    dialog = d;
    d.addEventListener('close', () => { if (dialog === d) dialog = null; d.remove(); });
    d.showModal();
    return d;
}
async function confirmAction(title, message) {
    const popup = context().Popup?.show?.confirm;
    return popup ? Boolean(await popup(title, message)) : globalThis.confirm(`${title}\n${message}`);
}
function field(label, input) {
    const wrap = el('label', 'wit-field');
    wrap.append(el('span', '', label), input);
    return wrap;
}
function entryTitle(entry) {
    return String(entry.comment || formatKeys(entry.key) || `엔트리 ${entry.uid}`);
}

// options.draft prefills the fields (an AI proposal); options.onSaved runs after a save.
async function openEditor(item, options = {}) {
    const key = chatKey();
    if (!key) { notify('채팅을 먼저 열어주세요.'); return; }
    const c = context();
    let raw = null;
    // A shared entry already copied in this chat opens its copy, never a second copy.
    const forward = item && chatState().replaced.find(r => r.world === item.world && String(r.uid) === String(item.uid));
    if (forward && (await c.loadWorldInfo(forward.book))?.entries?.[forward.copyUid]) {
        item = { ...item, world: forward.book, uid: forward.copyUid };
    }
    if (item) {
        raw = (await c.loadWorldInfo(item.world))?.entries?.[item.uid];
        if (!raw) { notify('엔트리를 찾지 못했어요. 삭제됐거나 책 연결이 바뀌었을 수 있어요.', true); return; }
        raw = structuredClone(raw);
    }
    if (key !== chatKey()) return;
    const book = chatBook();
    const inChatBook = !item || item.world === book;
    const rep = item ? replacementOf(item.world, item.uid) : null;
    const v = { ...(raw ?? {}), ...(options.draft ?? {}) };
    const d = modal(options.draft ? 'AI 제안 고치기' : item ? '엔트리 수정' : '새 엔트리 · 이 방 전용');

    const main = el('div', 'wit-dialog-body');
    const where = el('p', 'wit-where');
    if (!item) where.textContent = `현재: 📗 이 방 전용${book ? ` · ${book}` : ' · 저장할 때 책을 만들어요'}`;
    else if (inChatBook) where.textContent = `현재: 📗 이 방 전용${rep ? ` · 원본 ${rep.world}` : ` · ${item.world}`}`;
    else where.textContent = `현재: 📘 ${item.world} · 공용`;
    main.append(where);

    const title = el('input'); title.value = v.comment ?? '';
    const keys = el('input'); keys.value = formatKeys(v.key); keys.placeholder = '쉼표로 구분';
    const keys2 = el('input'); keys2.value = formatKeys(v.keysecondary);
    main.append(field('제목', title), field('키워드', keys), field('보조', keys2));

    // Activation mode, order and probability on one row.
    let mode = v.constant ? 'constant' : v.vectorized ? 'vectorized' : 'keyword';
    const modes = el('span', 'wit-modes');
    for (const kind of ['constant', 'keyword', 'vectorized']) {
        const b = button(modeIcons[kind], () => { mode = kind; for (const x of modes.children) x.classList.toggle('is-active', x.dataset.mode === mode); }, '', modeLabels[kind]);
        b.dataset.mode = kind; b.classList.toggle('is-active', kind === mode);
        modes.append(b);
    }
    const order = el('input'); order.type = 'number'; order.inputMode = 'numeric'; order.value = String(raw?.order ?? 100);
    const probability = el('input'); probability.type = 'number'; probability.inputMode = 'numeric'; probability.min = '0'; probability.max = '100';
    probability.value = String(raw?.probability ?? 100);
    const settingsRow = el('div', 'wit-settings-row');
    const orderLabel = el('label', '', '순서'); orderLabel.append(order);
    const probLabel = el('label', '', '확률'); probLabel.append(probability, el('span', 'wit-muted', '%'));
    settingsRow.append(modes, orderLabel, probLabel);
    main.append(settingsRow);

    const content = el('textarea', 'wit-content'); content.rows = 10; content.value = v.content ?? ''; content.setAttribute('aria-label', '본문');
    main.append(content);

    // Find & replace inside the body, e.g. "two weeks" -> "9 days".
    const findBox = el('div', 'wit-replace');
    const find = el('input'); find.placeholder = '찾을 말';
    const repl = el('input'); repl.placeholder = '바꿀 말';
    const replNote = el('small', 'wit-muted');
    findBox.append(find, repl, button('바꾸기', () => {
        const n = countOccurrences(content.value, find.value);
        if (!n) { replNote.textContent = '찾지 못했어요.'; return; }
        content.value = content.value.split(find.value).join(repl.value);
        replNote.textContent = `${n}곳 바꿨어요 (아직 저장 전)`;
    }, 'wit-quiet', '모두 바꾸기'));
    main.append(findBox, replNote);
    d.append(main);

    const number = (input, fallback, min, max) => {
        const n = Math.round(Number(input.value));
        return Number.isFinite(n) && input.value !== '' ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const edits = () => {
        const chance = number(probability, raw?.probability ?? 100, 0, 100);
        return {
            comment: title.value.trim(), key: parseKeys(keys.value), keysecondary: parseKeys(keys2.value), content: content.value,
            constant: mode === 'constant', vectorized: mode === 'vectorized',
            order: number(order, raw?.order ?? 100, -999999, 999999), probability: chance,
            useProbability: chance < 100 ? true : (raw?.useProbability ?? true),
        };
    };
    const finish = async ok => {
        if (!ok) return;
        closeDialog();
        try { await options.onSaved?.(); } catch (error) { notify(error.message, true); }
        scheduleRefresh();
    };
    const footer = el('div', 'wit-modal-footer');
    if (!item) {
        footer.append(button('이 방에 추가', async () => {
            if (!guard(key)) return;
            if (!edits().content.trim()) { notify('본문을 적어주세요.'); return; }
            finish(await run(() => addEntry(edits(), key)));
        }, 'wit-primary'));
    } else if (inChatBook) {
        footer.append(button('저장', async () => { if (guard(key)) finish(await run(() => saveInPlace(item.world, item.uid, edits()))); }, 'wit-primary'));
        if (rep) footer.append(button('원본으로 되돌리기', async () => {
            if (!guard(key)) return;
            const ok = await confirmAction('원본으로 되돌릴까요?', '이 방의 수정본을 지우고 공용 책의 원본을 다시 써요.');
            if (ok) finish(await run(() => revertCopy(rep, key)));
        }, 'wit-quiet'));
    } else {
        footer.append(button('이 방에만 저장', async () => { if (guard(key)) finish(await run(() => saveCopy(item, raw, edits(), key))); }, 'wit-primary'));
        footer.append(button('공용 책에 저장', async () => {
            if (!guard(key)) return;
            const ok = await confirmAction('공용 책에 저장할까요?', `"${item.world}"을(를) 쓰는 모든 채팅에 반영돼요.`);
            if (ok) finish(await run(() => saveInPlace(item.world, item.uid, edits())));
        }, 'wit-quiet'));
    }
    if (item) {
        footer.append(button('AI로 고치기', () => {
            aiTargets.clear(); aiTargets.set(entryKey(item.world, item.uid), entryTitle(raw));
            closeDialog(); tab = 'ai'; render(); aiInput.focus();
        }, 'wit-quiet', '이 엔트리만 AI에게 보내요'));
        footer.append(button('값 뽑기', () => {
            aiTargets.clear(); aiTargets.set(entryKey(item.world, item.uid), entryTitle(raw));
            closeDialog(); tab = 'ai'; render();
            aiInput.value = '이 엔트리에서 이야기가 진행되면 바뀌는 값(날짜·타이머·개수·랭크·소속·상태 등)을 찾아서 {{getvar::이름}} 변수로 바꿔줘. 변수의 값은 지금 채팅 기준으로 정해줘.';
            aiInput.focus();
        }, 'wit-quiet', 'AI가 바뀌는 값을 변수로 바꾸는 제안을 만들어요'));
        const backup = await readBackup(item.world, item.uid);
        if (backup && dialog === d) footer.append(button('저장 전 내용 불러오기', () => {
            title.value = backup.comment; keys.value = formatKeys(backup.key); keys2.value = formatKeys(backup.keysecondary);
            content.value = backup.content;
            notify('마지막 저장 직전 내용을 불러왔어요. 저장해야 반영돼요.');
        }, 'wit-quiet'));
    }
    d.append(footer);
}

// ---------- AI ----------
let aiBusy = false, aiAbort = null, aiError = '', aiRaw = '', aiNote = '';
// Entries the user picked for the next request (entryKey -> title); empty = automatic.
const aiTargets = new Map();
// Older builds don't expose the profile service on getContext(); shared.js always has it.
let sharedServices = null;
async function loadSharedServices() {
    try { sharedServices = await import('../../shared.js'); } catch (error) { console.warn('[WorldInfo Tracker] Connection service module unavailable', error); }
}
function connectionService() { return context().ConnectionManagerRequestService || sharedServices?.ConnectionManagerRequestService; }
function profiles() {
    const c = context();
    if (c.extensionSettings?.disabledExtensions?.includes('connection-manager')) return [];
    const rows = c.extensionSettings?.connectionManager?.profiles || [], service = connectionService();
    return rows.filter(p => {
        try { return p?.id && (service?.isProfileSupported ? service.isProfileSupported(p) : ['openai', 'textgenerationwebui'].includes(c.CONNECT_API_MAP?.[p.api]?.selected)); } catch { return false; }
    });
}
function connectionLabel() {
    const id = settings().profileId;
    if (!id) return '현재 채팅 API';
    return profiles().find(p => p.id === id)?.name ?? '연결 프로필 없음';
}
async function callAi(messages, signal) {
    const c = context(), s = settings();
    try {
        if (s.profileId) {
            const service = connectionService();
            if (typeof service?.sendRequest !== 'function') throw new Error('연결 프로필 요청을 지원하지 않는 SillyTavern 버전이에요.');
            // 'min' turns reasoning off where the backend supports it (Gemini thinking budget 0).
            const override = s.thinking && s.thinking !== 'auto' ? { reasoning_effort: s.thinking } : {};
            const res = await service.sendRequest(s.profileId, messages, s.maxTokens, { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true }, override);
            return typeof res === 'string' ? res : String(res?.content ?? '');
        }
        if (typeof c.generateRaw !== 'function') throw new Error('generateRaw를 지원하는 SillyTavern 버전이 필요해요.');
        return String(await c.generateRaw({ prompt: messages, responseLength: s.maxTokens, trimNames: false }) ?? '');
    } catch (error) {
        throw new Error(`AI 요청 실패: ${error.cause?.message || error.message}`);
    }
}
// Turns the model's proposals into cards. Only entries it saw in full may be changed.
function buildReady(list, details, { request = '', auto = false } = {}) {
    const detailed = new Map(details.map(e => [entryKey(e.world, e.uid), e]));
    const ready = [];
    let dropped = 0;
    for (const p of list) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (p.action === 'create') { ready.push({ ...p, id, request, auto }); continue; }
        const target = detailed.get(entryKey(p.world, p.uid));
        if (!target) { dropped++; continue; }
        if (p.edits.length) {
            const { content, missing } = applyEdits(target.content, p.edits);
            if (missing.length || content === target.content) { dropped++; continue; }
            p.content = content;
        }
        ready.push({ ...p, id, request, auto, title: entryTitle(target), world: target.world, uid: target.uid, base: target.content ?? '', baseKey: target.key ?? [], disable: Boolean(target.disable) });
    }
    return { ready, dropped };
}
const summarize = ({ applied = [], ready = [], dropped = 0 }) => [
    applied.length ? `현재 값 ${applied.length}개 바꿈 (${describeChanges(applied)})` : '',
    ready.length ? `제안 ${ready.length}개` : '',
    dropped ? `맞지 않아 버린 수정 ${dropped}개` : '',
].filter(Boolean).join(' · ');

// Character card(s), persona and author's note, as the AI tab and tracking send them.
const SETUP_MAX_CHARS = 8000;
function storySetup() {
    const c = context(), s = settings(), out = [];
    const add = (label, text) => {
        const t = String(c.substituteParams?.(String(text ?? '')) ?? text ?? '').trim();
        if (t) out.push({ label, text: t.length > SETUP_MAX_CHARS ? `${t.slice(0, SETUP_MAX_CHARS)}…` : t });
    };
    const group = c.groupId != null ? c.groups?.find(g => String(g.id) === String(c.groupId)) : null;
    const chars = group ? (c.characters || []).filter(ch => group.members?.includes(ch.avatar)) : [c.characters?.[c.characterId]].filter(Boolean);
    if (s.sendCard) for (const ch of chars) {
        add(`Character card: ${ch.name}`, [ch.description, ch.personality && `Personality: ${ch.personality}`, ch.scenario && `Scenario: ${ch.scenario}`].filter(Boolean).join('\n\n'));
    }
    if (s.sendPersona) add(`User persona: ${c.name1 || 'User'}`, c.powerUserSettings?.persona_description);
    if (s.sendNote) {
        add("Author's note", c.chatMetadata?.note_prompt);
        for (const ch of chars) {
            const file = String(ch.avatar || '').replace(/\.[^.]+$/, '');
            add(`Character author's note: ${ch.name}`, c.extensionSettings?.note?.chara?.find(x => x.name === file)?.prompt);
        }
    }
    return out;
}

async function askAi() {
    const key = chatKey(), request = aiInput.value.trim();
    if (!key) { notify('채팅을 먼저 열어주세요.'); return; }
    if (!request) { notify('요청을 적어주세요.'); return; }
    if (isGenerating()) { notify('응답 생성이 끝난 뒤 요청해주세요.'); return; }
    if (aiBusy) return;
    const controller = new AbortController();
    aiBusy = true; aiAbort = controller; aiError = ''; aiRaw = ''; aiNote = ''; render();
    try {
        const entries = await getSortedEntries();
        const activeKeys = new Set(result.chat === key ? result.entries.map(e => entryKey(e.world, e.uid)) : []);
        const chatLines = thinTagBlocks(recentChatLines(context().chat, settings().chatTurns), parseTagList(settings().trackTags));
        const details = pickDetails(entries, { request, activeKeys, targets: new Set(aiTargets.keys()), globals: scanGlobals() });
        const messages = buildAiMessages({ request, entries, details, chatLines, vars: promptVars(entries), setup: storySetup(), rules: rulesFor('ask'), extra: settings().customPrompt });
        const text = await callAi(messages, controller.signal);
        if (controller.signal.aborted || key !== chatKey()) return;
        aiRaw = text;
        const parsed = parseAiResult(text);
        const known = trackedVarNames(entries);
        const applied = await writeVars(parsed.vars.filter(v => known.has(v.name)), 'ask', key);
        const { ready, dropped } = buildReady(parsed.proposals, details, { request });
        await writeChatState(st => { st.proposals = [...ready, ...st.proposals]; }, key);
        aiInput.value = '';
        if (!ready.length && !applied.length) notify(dropped ? 'AI의 수정안이 엔트리와 맞지 않아 버렸어요. 대상 엔트리를 골라서 다시 요청해보세요.' : 'AI가 바꿀 게 없다고 했어요.');
        else notify(summarize({ applied, ready, dropped }));
    } catch (error) {
        if (!controller.signal.aborted) aiError = error.message || String(error);
    } finally {
        if (aiAbort === controller) { aiBusy = false; aiAbort = null; }
        render();
    }
}

// ---------- Auto tracking ----------
const HOLD_TURNS = 2;          // newest turns wait, so a swipe or regenerate never leaks in
const MAX_PART_CHARS = 36000;  // one request reads at most this much chat
const MAX_PARTS = 5;
const TRACK_BODY_BUDGET = 16000;
let trackRetryAt = 0;

async function setBookmarkToEnd(key) {
    const chat = context().chat || [];
    await writeChatState(st => { st.trackAt = chat.length; st.trackSig = messageSig(chat[chat.length - 1]); }, key);
}
/** Reads the new part of the chat and reports value changes (applied now), stale info and new facts (as cards). */
async function trackChat({ manual = false } = {}) {
    const key = chatKey(), s = settings(), chat = context().chat || [];
    const say = text => { if (manual) notify(text); };
    if (!key) return say('채팅을 먼저 열어주세요.');
    if (isGenerating()) return say('응답 생성이 끝난 뒤 확인해주세요.');
    if (aiBusy) return say('AI가 이미 일하는 중이에요.');
    if (!manual && Date.now() < trackRetryAt) return;
    const state = chatState(), at = relocateBookmark(chat, state.trackAt, state.trackSig);
    if (at === null && !manual) {
        // First sight of this chat: start counting from here, never read the past.
        try { await setBookmarkToEnd(key); } catch (error) { console.warn('[WorldInfo Tracker]', error); }
        return render();
    }
    let range = pickRange(chat, at, { every: s.autoEvery, hold: HOLD_TURNS, force: manual });
    if (!range && manual) {
        // Nothing behind the bookmark (e.g. auto tracking was just switched on): offer the latest turns.
        range = pickRange(chat, null, { every: s.autoEvery, force: true });
        if (!range) return say('읽을 대화가 없어요.');
        const guess = formatLines(range.messages).reduce((n, line) => n + line.length, 0);
        if (!(await confirmAction('새로 읽을 대화가 없어요', `마지막으로 읽은 곳 이후는 비어 있어요. 최근 ${range.turns}턴(약 ${guess.toLocaleString()}자)을 다시 읽을까요?`))) return;
    }
    if (!range) return;

    const tags = parseTagList(s.trackTags);
    const lines = thinTagBlocks(formatLines(range.messages), tags);
    let parts = splitParts(lines, MAX_PART_CHARS), skipped = false;
    if (parts.length > MAX_PARTS) { parts = parts.slice(-MAX_PARTS); skipped = true; }
    const chars = parts.flat().reduce((n, line) => n + line.length, 0);
    if (manual && chars > 60000 && !(await confirmAction('대화를 많이 읽어요', `${range.turns}턴 · 약 ${chars.toLocaleString()}자를 AI가 읽어요. 계속할까요?`))) return;

    const controller = new AbortController();
    aiBusy = true; aiAbort = controller; aiError = ''; aiRaw = '';
    aiNote = `대화 ${range.turns}턴 · 약 ${chars.toLocaleString()}자를 읽는 중…`; render();
    try {
        const entries = await getSortedEntries();
        const known = trackedVarNames(entries), applied = [], allReady = [];
        let dropped = 0;
        const setup = storySetup();
        for (const [i, part] of parts.entries()) {
            if (parts.length > 1) { aiNote = `대화를 읽는 중… (${i + 1}/${parts.length})`; render(); }
            const details = pickTrackDetails(entries, part.join('\n'), { budget: TRACK_BODY_BUDGET, globals: scanGlobals() });
            const messages = buildTrackMessages({ lines: part, vars: promptVars(entries), entries, details, setup, rules: rulesFor('track'), extra: s.customPrompt, part: parts.length > 1 ? { i: i + 1, n: parts.length } : null });
            const reply = await callAi(messages, controller.signal);
            if (controller.signal.aborted || key !== chatKey()) return;
            aiRaw = reply;
            const parsed = parseAiResult(reply);
            applied.push(...await writeVars(parsed.vars.filter(v => known.has(v.name)), 'auto', key));
            const built = buildReady(parsed.proposals, details, { auto: true });
            allReady.push(...built.ready); dropped += built.dropped;
        }
        // The bookmark only moves once every part has been read.
        await writeChatState(st => {
            st.proposals = [...allReady, ...st.proposals];
            st.trackAt = range.end; st.trackSig = messageSig(chat[range.end - 1]);
            st.trackLast = { time: Date.now(), turns: range.turns, chars, parts: parts.length, vars: applied.length, proposals: allReady.length, dropped, manual };
        }, key);
        const summary = summarize({ applied, ready: allReady, dropped });
        if (summary || manual) notify(`${manual ? `대화 ${range.turns}턴을 읽었어요. ` : ''}${summary || '바꿀 게 없어요.'}${skipped ? ' (너무 길어서 앞부분은 건너뛰었어요)' : ''}`);
    } catch (error) {
        if (!controller.signal.aborted) {
            aiError = `대화 확인 · ${error.message || String(error)}`;
            trackRetryAt = Date.now() + 10 * 60 * 1000;
            if (!manual) notify(`자동 추적에 실패했어요. 10분 뒤 다시 시도해요. (${error.message || error})`, true);
        }
    } finally {
        if (aiAbort === controller) { aiBusy = false; aiAbort = null; aiNote = ''; }
        render();
    }
}
async function maybeAutoTrack() {
    if (!active || !settings().autoOn || aiBusy || isGenerating() || !chatKey()) return;
    await trackChat({ manual: false });
}
function cancelAi() { aiAbort?.abort(); aiBusy = false; aiAbort = null; aiNote = ''; render(); }
async function dropProposal(id, key = chatKey()) {
    try { await writeChatState(s => { s.proposals = s.proposals.filter(p => p.id !== id); }, key); } catch (error) { notify(error.message, true); }
    render();
}
// An update lands on this chat's copy when one exists.
async function proposalTarget(p) {
    const fwd = chatState().replaced.find(r => r.world === p.world && String(r.uid) === String(p.uid));
    if (fwd && (await context().loadWorldInfo(fwd.book))?.entries?.[fwd.copyUid]) return { world: fwd.book, uid: fwd.copyUid };
    return { world: p.world, uid: p.uid };
}
function proposalEdits(p, raw) {
    return p.action === 'create'
        ? { comment: p.comment, key: p.key, keysecondary: [], content: p.content, constant: p.constant }
        : { comment: p.comment || raw?.comment || '', key: p.key.length ? p.key : (raw?.key ?? []), content: p.content };
}
// A proposal can carry variables its edits rely on ({{getvar::name}}); they are set when it is applied.
async function applyProposalVars(p, key) {
    if (!p.vars?.length) return;
    try {
        const done = await writeVars(p.vars.map(v => ({ name: v.name, value: v.value, reason: p.reason })), 'proposal', key, { track: true });
        if (done.length) notify(`현재 값 ${done.length}개를 정했어요: ${describeChanges(done)}`);
    } catch (error) { notify(error.message, true); }
}
async function applyProposal(p, where) {
    const key = chatKey();
    if (!guard(key)) return;
    if (p.action === 'create') {
        if (await run(() => addEntry(proposalEdits(p), key))) { await applyProposalVars(p, key); await dropProposal(p.id, key); }
        scheduleRefresh();
        return;
    }
    const target = await proposalTarget(p);
    const raw = (await context().loadWorldInfo(target.world))?.entries?.[target.uid];
    if (!raw) { notify('대상 엔트리를 찾지 못했어요. 삭제됐을 수 있어요.', true); return; }
    if ((raw.content ?? '') !== p.base && !(await confirmAction('엔트리가 그 사이 바뀌었어요', 'AI가 본 내용과 지금 내용이 달라요. 그래도 덮어쓸까요?'))) return;
    const edits = proposalEdits(p, raw);
    let ok;
    if (target.world === chatBook()) ok = await run(() => saveInPlace(target.world, target.uid, edits));
    else if (where === 'shared') {
        if (!(await confirmAction('공용 책에 적용할까요?', `"${target.world}"을(를) 쓰는 모든 채팅에 반영돼요.`))) return;
        ok = await run(() => saveInPlace(target.world, target.uid, edits));
    } else ok = await run(() => saveCopy({ world: target.world, uid: target.uid, disable: p.disable }, structuredClone(raw), edits, key));
    if (ok) { await applyProposalVars(p, key); await dropProposal(p.id, key); }
    scheduleRefresh();
}
async function editProposal(p) {
    const key = chatKey();
    const onSaved = async () => { await applyProposalVars(p, key); await dropProposal(p.id, key); };
    if (p.action === 'create') return openEditor(null, { draft: proposalEdits(p), onSaved });
    const target = await proposalTarget(p);
    const raw = (await context().loadWorldInfo(target.world))?.entries?.[target.uid];
    return openEditor({ world: p.world, uid: p.uid, disable: p.disable }, { draft: proposalEdits(p, raw), onSaved });
}
function diffView(before, after) {
    const ops = lineDiff(before, after), box = el('div', 'wit-diff');
    // Show changed lines with one line of context; collapse the rest.
    const changed = i => Boolean(ops[i]) && ops[i].type !== 'same';
    const keep = ops.map((_, i) => changed(i) || changed(i - 1) || changed(i + 1));
    let skipped = false;
    ops.forEach((op, i) => {
        if (!keep[i]) { if (!skipped) box.append(el('div', 'wit-diff-skip', '⋯')); skipped = true; return; }
        skipped = false;
        box.append(el('div', `wit-diff-${op.type}`, op.text || ' '));
    });
    return box;
}
function proposalCard(p) {
    const card = el('article', 'wit-card');
    const isCreate = p.action === 'create';
    const inChat = !isCreate && (p.world === chatBook() || chatState().replaced.some(r => r.world === p.world && String(r.uid) === String(p.uid)));
    const head = el('div', 'wit-card-head');
    head.append(el('span', `wit-kind is-${p.action}`, isCreate ? '새 엔트리' : '수정'), el('strong', '', p.comment || p.title || (isCreate ? '제목 없음' : `엔트리 ${p.uid}`)));
    if (p.auto) head.append(el('span', 'wit-tag', '자동'));
    card.append(head, el('small', 'wit-muted', isCreate ? '📗 이 방 전용 책에 추가' : inChat ? '📗 이 방' : `📘 ${p.world} · 공용`));
    if (p.reason) card.append(el('p', 'wit-reason', p.reason));
    if (isCreate) {
        if (p.key.length || p.constant) {
            const keys = el('div', 'wit-why');
            if (p.constant) keys.append(el('span', '', '🔵 상시 '));
            for (const k of p.key) keys.append(el('span', 'wit-key', k));
            card.append(keys);
        }
        card.append(el('pre', 'wit-preview', p.content));
    } else {
        if (p.key.length && formatKeys(p.key) !== formatKeys(p.baseKey)) card.append(el('small', 'wit-why', `키워드: ${formatKeys(p.baseKey) || '없음'} → ${formatKeys(p.key)}`));
        card.append(diffView(p.base, p.content));
    }
    if (p.vars?.length) card.append(el('small', 'wit-why', `현재 값: ${p.vars.map(v => `${v.name} = ${v.value}`).join(' · ')}`));
    const actions = el('div', 'wit-card-actions');
    if (isCreate) actions.append(button('이 방에 추가', () => applyProposal(p, 'here'), 'wit-primary'));
    else if (inChat) actions.append(button('적용', () => applyProposal(p, 'here'), 'wit-primary'));
    else actions.append(button('이 방에만 적용', () => applyProposal(p, 'here'), 'wit-primary'), button('공용에 적용', () => applyProposal(p, 'shared'), 'wit-quiet'));
    actions.append(button('고쳐서 적용', () => editProposal(p), 'wit-quiet'), button('버리기', () => dropProposal(p.id), 'wit-quiet'));
    for (const b of actions.children) b.disabled = busy;
    card.append(actions);
    return card;
}
function renderTargets() {
    aiTargetRow.replaceChildren(el('span', 'wit-muted', '대상'));
    if (!aiTargets.size) aiTargetRow.append(el('span', 'wit-target-auto', '자동 (요청에 나온 것·이번 응답)'));
    for (const [k, title] of aiTargets) {
        const chip = button(`${title} ×`, () => { aiTargets.delete(k); render(); }, 'wit-target', `${title} 빼기`);
        aiTargetRow.append(chip);
    }
    aiTargetRow.append(button('＋ 고르기', openTargetPicker, 'wit-quiet', 'AI에게 보낼 엔트리 고르기'));
}
// Picking entries keeps a request small: only their bodies are sent.
async function openTargetPicker() {
    if (!chatKey()) { notify('채팅을 먼저 열어주세요.'); return; }
    let entries;
    try { entries = await getSortedEntries(); } catch (error) { notify(`월드인포를 읽지 못했어요: ${error.message}`, true); return; }
    const d = modal('AI에게 보낼 엔트리');
    const main = el('div', 'wit-dialog-body');
    const find = el('input'); find.type = 'search'; find.placeholder = '제목 · 키워드 검색';
    const list = el('div', 'wit-pick-list');
    const picked = new Map(aiTargets);
    const draw = () => {
        const q = find.value.trim().toLocaleLowerCase();
        list.replaceChildren();
        for (const e of entries) {
            const title = entryTitle(e), k = entryKey(e.world, e.uid);
            if (q && !`${title} ${formatKeys(e.key)}`.toLocaleLowerCase().includes(q)) continue;
            const row = el('label', 'wit-pick');
            const box = el('input'); box.type = 'checkbox'; box.checked = picked.has(k);
            box.addEventListener('change', () => { if (box.checked) picked.set(k, title); else picked.delete(k); });
            const size = String(e.content || '').length;
            row.append(box, el('span', '', title), el('small', 'wit-muted', `${e.world === chatBook() ? '📗' : '📘'} ${size.toLocaleString()}자`));
            list.append(row);
        }
    };
    find.addEventListener('input', draw);
    draw();
    main.append(find, list);
    const footer = el('div', 'wit-modal-footer');
    footer.append(button('이걸로', () => { aiTargets.clear(); for (const [k, t] of picked) aiTargets.set(k, t); closeDialog(); render(); }, 'wit-primary'),
        button('자동으로', () => { aiTargets.clear(); closeDialog(); render(); }, 'wit-quiet'));
    d.append(main, footer);
}
const since = time => {
    const min = Math.round((Date.now() - time) / 60000);
    return min < 1 ? '방금' : min < 60 ? `${min}분 전` : min < 1440 ? `${Math.round(min / 60)}시간 전` : `${Math.round(min / 1440)}일 전`;
};
// Where the auto-tracking bookmark is, and what the last run did.
function trackBlock() {
    const s = settings(), chat = context().chat || [], st = chatState();
    const at = relocateBookmark(chat, st.trackAt, st.trackSig), box = el('div', 'wit-track');
    let line;
    if (!s.autoOn) line = '자동 추적 꺼짐 · 설정 탭에서 켤 수 있어요';
    else if (at === null) line = `자동 추적 · ${s.autoEvery}턴마다 · 다음 응답부터 세요`;
    else {
        const pending = pendingTurns(chat, at), need = s.autoEvery + HOLD_TURNS;
        line = `자동 추적 · ${s.autoEvery}턴마다 · 쌓인 턴 ${Math.min(pending, need)}/${need}${pending >= need ? ' · 곧 실행' : ''}`;
    }
    const top = el('div', 'wit-track-row');
    top.title = `${s.autoEvery}턴을 읽으려면 최신 ${HOLD_TURNS}턴이 확정될 때까지 기다려서, ${s.autoEvery + HOLD_TURNS}턴이 쌓이면 실행돼요`;
    const check = button('지금 확인', () => trackChat({ manual: true }), 'wit-quiet', '마지막으로 읽은 곳 이후의 대화를 지금 읽어요');
    check.disabled = aiBusy || busy;
    top.append(el('small', 'wit-muted', line), check);
    box.append(top);
    const last = st.trackLast;
    if (last) box.append(el('small', 'wit-muted', `마지막 확인 ${since(last.time)} · ${last.turns}턴 읽음 · 값 ${last.vars}개 · 제안 ${last.proposals}개`));
    return box;
}
function renderAi() {
    const s = settings();
    renderTargets();
    const thinking = s.profileId ? ` · 생각 ${({ min: '끔', low: '낮게', auto: '모델 기본' })[s.thinking] ?? s.thinking}` : '';
    aiMeta.textContent = `${connectionLabel()}${thinking} · 최근 대화 ${s.chatTurns}턴`;
    aiSend.textContent = aiBusy ? '취소' : '보내기';
    aiSend.className = aiBusy ? 'wit-quiet' : 'wit-primary';
    body.append(trackBlock());
    if (aiBusy) body.append(el('p', 'wit-note', aiNote || 'AI가 엔트리를 살펴보는 중…'));
    if (aiError) {
        body.append(el('p', 'wit-error', aiError));
        if (aiRaw.trim()) {
            const raw = el('details', 'wit-raw');
            raw.append(el('summary', '', 'AI 응답 원문 보기'), el('pre', 'wit-preview', aiRaw));
            body.append(raw);
        }
    }
    const proposals = chatState().proposals;
    if (!proposals.length && !aiBusy && !aiError) {
        body.append(el('p', 'wit-empty', 'AI 제안은 바로 저장되지 않아요.\n확인하고 적용할 것만 고르면 돼요.'));
    }
    for (const p of proposals) body.append(proposalCard(p));
}

// ---------- 현재 값 (chat variables) ----------
async function saveVar(name, value, source = 'user') {
    try {
        const done = await writeVars([{ name, value }], source, chatKey(), { track: source === 'user' });
        if (done.length) notify(`${describeChanges(done)} · 다음 응답부터 적용돼요`);
    } catch (error) { notify(error.message, true); }
    render(true);
}
function varRow(name, value, titles, log, missing = false) {
    const row = el('div', `wit-var${missing ? ' is-missing' : ''}`);
    const head = el('div', 'wit-var-head');
    const input = el('input'); input.value = value; input.placeholder = missing ? '값을 적어주세요' : '';
    input.setAttribute('aria-label', `${name} 값`);
    input.addEventListener('change', () => saveVar(name, input.value.trim()));
    const label = el('label', 'wit-var-field'); label.append(el('span', 'wit-var-name', name), input);
    head.append(label);
    if (!missing) {
        head.append(button('✕', async () => {
            if (await confirmAction('변수를 지울까요?', `"${name}"을(를) 쓰는 엔트리는 그 자리가 빈칸이 돼요.`)) { await saveVar(name, null); }
        }, 'wit-quiet', `${name} 지우기`));
    }
    row.append(head);
    if (titles?.length) row.append(el('small', 'wit-muted', `쓰는 엔트리: ${titles.join(', ')}`));
    else if (!missing) row.append(el('small', 'wit-muted', '쓰는 엔트리 없음'));
    if (log && !missing) {
        const note = el('small', 'wit-var-log', `${log.source === 'user' ? '직접' : 'AI'} ${since(log.time)} · ${log.from ?? '없음'} → ${log.to ?? '삭제'}`);
        if (log.from !== null && chatVars()[name] === log.to) note.append(' ', button('되돌리기', () => saveVar(name, log.from, 'user'), 'wit-link'));
        row.append(note);
    }
    return row;
}
function renderVars() {
    const all = chatVars(), loaded = allChat === chatKey(), refs = loaded ? findVarRefs(allEntries) : new Map(), st = chatState();
    const tracked = new Set([...st.tracked, ...refs.keys()]);
    body.append(el('p', 'wit-note', '엔트리가 {{getvar::이름}}으로 읽는 값과 여기서 추가한 값이에요 · 고치면 다음 응답부터 적용돼요'));
    const names = [...tracked].filter(n => Object.hasOwn(all, n));
    for (const name of names) body.append(varRow(name, all[name], refs.get(name), st.varLog.find(l => l.name === name)));
    if (!names.length) body.append(el('p', 'wit-empty', '아직 관리하는 값이 없어요.\n아래에서 추가하거나, 엔트리 수정 창의 "값 뽑기"로 AI에게 맡길 수 있어요.'));
    const missing = [...refs.keys()].filter(n => !Object.hasOwn(all, n));
    if (missing.length) {
        const warn = el('section', 'wit-var-missing');
        warn.append(el('h4', '', '⚠ 값이 없는 변수 · 엔트리에서 쓰고 있어요'));
        for (const name of missing) warn.append(varRow(name, '', refs.get(name), null, true));
        body.append(warn);
    }
    const add = el('form', 'wit-var-add');
    const name = el('input'); name.placeholder = '이름 (예: 2층_Break)'; name.setAttribute('aria-label', '새 변수 이름');
    const value = el('input'); value.placeholder = '값'; value.setAttribute('aria-label', '새 변수 값');
    const go = button('＋ 추가', () => {}, 'wit-primary'); go.type = 'submit';
    add.addEventListener('submit', event => {
        event.preventDefault();
        const n = validVarName(name.value);
        if (!n) { notify('이름에는 { } :: 와 줄바꿈을 쓸 수 없어요.'); return; }
        saveVar(n, value.value.trim());
    });
    add.append(name, value, go);
    body.append(add);
}

function whyLine(entry) {
    const line = el('small', 'wit-why');
    const why = entry.why;
    if (!why) { line.textContent = entry.constant ? '상시' : formatKeys(entry.key) || '키워드 없음'; return line; }
    if (why.mode === 'constant') { line.textContent = '상시'; return line; }
    if (why.primary.length) {
        if (why.source === 'recursion') line.append(el('span', '', '다른 엔트리 본문에서 '));
        for (const k of why.primary) line.append(el('span', 'wit-key', k));
        if (why.secondary.length) {
            line.append(el('span', '', ' + 보조 '));
            for (const k of why.secondary) line.append(el('span', 'wit-key', k));
        }
        return line;
    }
    line.textContent = why.mode === 'vectorized' ? '벡터 검색으로 활성' : '키워드를 채팅에서 못 찾음 (스티키·확률·외부 활성 등)';
    return line;
}
function isOn(entry, toggles) {
    const on = toggles[entryKey(entry.world, entry.uid)];
    return typeof on === 'boolean' ? on : (fileOn.get(entryKey(entry.world, entry.uid)) ?? !entry.disable);
}
async function toggleEntry(entry) {
    const key = chatKey();
    if (!guard(key)) return;
    const k = entryKey(entry.world, entry.uid), next = !isOn(entry, chatState().toggles);
    await run(() => writeChatState(s => {
        // Back to the book's own state means no override is needed.
        if (fileOn.has(k) && fileOn.get(k) === next) delete s.toggles[k]; else s.toggles[k] = next;
    }, key));
    scheduleRefresh();
}
function renderEntries(list) {
    const toggles = chatState().toggles;
    const book = chatBook(), query = search.trim().toLocaleLowerCase();
    const groups = new Map();
    for (const entry of list) {
        const haystack = `${entryTitle(entry)} ${entry.world} ${formatKeys(entry.key)}`.toLocaleLowerCase();
        if (query && !haystack.includes(query)) continue;
        if (!groups.has(entry.world)) groups.set(entry.world, []);
        groups.get(entry.world).push(entry);
    }
    if (!groups.size) { body.append(el('p', 'wit-empty', query ? '검색 결과가 없어요.' : '엔트리가 없어요.')); return; }
    // This chat's own book first.
    const order = [...groups.keys()].sort((a, b) => (b === book) - (a === book));
    for (const world of order) {
        const section = el('section', 'wit-section');
        section.append(el('h4', '', world === book ? `📗 이 방 전용 · ${world}` : `📘 ${world}`));
        for (const entry of groups.get(world)) {
            const mode = entry.why?.mode ?? (entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'keyword');
            const row = el('div', 'wit-row');
            const main = button('', () => openEditor(entry), 'wit-row-main', `${entryTitle(entry)} 수정`);
            const icon = el('span', 'wit-mode', modeIcons[mode]); icon.title = modeLabels[mode];
            const copy = el('span', 'wit-copy');
            copy.append(el('strong', '', entryTitle(entry)), whyLine(entry));
            main.append(icon, copy);
            if (world === book && replacementOf(world, entry.uid)) main.append(el('span', 'wit-tag', '수정본'));
            main.disabled = busy;
            const on = isOn(entry, toggles), overridden = typeof toggles[entryKey(world, entry.uid)] === 'boolean';
            const toggle = button(on ? 'ON' : 'OFF', () => toggleEntry(entry), `wit-switch${on ? ' is-on' : ''}${overridden ? ' is-chat' : ''}`,
                `${entryTitle(entry)} · 이 채팅에서 ${on ? '끄기' : '켜기'}${overridden ? ' (이 채팅에서 바꾼 상태)' : ''}`);
            toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(on));
            toggle.disabled = busy;
            row.append(main, toggle);
            section.append(row);
        }
        body.append(section);
    }
}
function renderActive() {
    if (!hasActivationHook) { body.append(el('p', 'wit-empty', '이 SillyTavern 버전은 활성화 조회를 지원하지 않아요.')); return; }
    const known = result.chat === chatKey() && result.phase === 'ready';
    if (!known) { body.append(el('p', 'wit-empty', result.phase === 'pending' && result.chat === chatKey() ? '활성화 확인 중…' : '응답을 한 번 생성하면 여기에 보여요.')); return; }
    body.append(el('p', 'wit-note', `${result.saved ? '마지막으로 기록된 응답' : '이번 응답'}에 들어간 엔트리 ${result.entries.length}개 · 키워드는 추정 · ON/OFF는 이 채팅만, 다음 응답부터`));
    if (!result.entries.length) { body.append(el('p', 'wit-empty', '활성화된 엔트리가 없어요.')); return; }
    renderEntries(result.entries);
}
function renderAll() {
    if (allError) { body.append(el('p', 'wit-error', allError)); return; }
    if (allChat !== chatKey()) { body.append(el('p', 'wit-empty', '불러오는 중…')); return; }
    body.append(el('p', 'wit-note', `이 채팅에 연결된 엔트리 ${allEntries.length}개 · ON/OFF는 이 채팅만`));
    renderEntries(allEntries);
}
function render(force = false) {
    updateBadge();
    if (!panel || panel.hidden) return;
    // Don't rebuild the value list under someone who is typing in it.
    if (!force && tab === 'vars' && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const book = chatBook();
    subtitle.textContent = chatKey() ? (book ? `이 방 전용 책: ${book}` : '이 방 전용 책: 아직 없음 · 처음 저장할 때 만들어요') : '채팅을 열어주세요';
    const pending = chatKey() ? chatState().proposals.length : 0;
    for (const b of panel.querySelectorAll('.wit-tabs button')) {
        b.classList.toggle('is-active', b.dataset.tab === tab);
        if (b.dataset.tab === 'ai') b.textContent = pending ? `AI ${pending}` : 'AI';
    }
    toolbar.hidden = tab !== 'active' && tab !== 'all';
    aiBox.hidden = tab !== 'ai';
    setupBox.hidden = tab !== 'setup';
    body.hidden = tab === 'setup';
    body.replaceChildren();
    if (!chatKey() && tab !== 'setup') body.append(el('p', 'wit-empty', '채팅을 열어주세요.'));
    else if (tab === 'active') renderActive();
    else if (tab === 'ai') renderAi();
    else if (tab === 'vars') renderVars();
    else if (tab === 'setup') { /* persistent form */ }
    else renderAll();
    status.textContent = busy ? '저장 중…' : isGenerating() ? '생성 중에는 저장할 수 없어요' : '';
}
function updateBadge() {
    if (!badge || !launcher) return;
    const known = result.chat === chatKey() && result.phase === 'ready';
    badge.hidden = !known;
    badge.textContent = known ? String(result.entries.length) : '';
}

async function refreshAll() {
    if (!active || !chatKey() || !panel || panel.hidden || (tab !== 'all' && tab !== 'vars')) return;
    const token = ++allToken, key = chatKey();
    try {
        const list = await getSortedEntries();
        if (token !== allToken || key !== chatKey()) return;
        allEntries = list.map(e => ({ world: e.world, uid: e.uid, comment: e.comment, key: e.key, keysecondary: e.keysecondary, content: e.content, constant: e.constant, vectorized: e.vectorized, disable: e.disable }));
        allChat = key; allError = '';
    } catch (error) {
        if (token !== allToken) return;
        allError = `월드인포를 읽지 못했어요: ${error.message}`;
    }
    render();
}
function scheduleRefresh() {
    if (!active) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!active) return; render(); refreshAll(); }, 100);
}

function setPanelOpen(open) {
    if (!panel) return;
    if (open) {
        panel.hidden = false;
        // Escape theme stacking contexts and extension drawers on mobile.
        if (typeof panel.showPopover === 'function') {
            panel.setAttribute('popover', 'manual');
            if (!panel.matches(':popover-open')) panel.showPopover();
        }
        launcher?.setAttribute('aria-expanded', 'true');
        render(); refreshAll();
    } else {
        if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
        panel.hidden = true;
        launcher?.setAttribute('aria-expanded', 'false');
    }
}
function floatingViewport() {
    const v = globalThis.visualViewport;
    return { width: v?.width || globalThis.innerWidth || 390, height: v?.height || globalThis.innerHeight || 700, offsetLeft: v?.offsetLeft || 0, offsetTop: v?.offsetTop || 0 };
}
function showFloatingIcon() {
    if (!active || !launcher) return;
    const visible = settings().showIcon;
    launcher.style.setProperty('display', visible ? 'block' : 'none', 'important');
    if (!visible) {
        if (typeof launcher.hidePopover === 'function' && launcher.matches(':popover-open')) launcher.hidePopover();
        return;
    }
    const target = touchSize(floatingSize);
    for (const name of ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height']) launcher.style.setProperty(name, `${target}px`, 'important');
    launcher.style.setProperty('font-size', `${Math.round(floatingSize * .56)}px`, 'important');
    launcher.style.setProperty('line-height', `${target}px`, 'important');
    const { x, y } = positionPixels(previewPosition || savedPosition, floatingViewport(), floatingSize);
    launcher.style.setProperty('left', `${x}px`, 'important');
    launcher.style.setProperty('top', `${y}px`, 'important');
    // The icon itself must escape clipping/stacking contexts too.
    if (typeof launcher.showPopover === 'function') {
        launcher.setAttribute('popover', 'manual');
        try { if (!launcher.matches(':popover-open')) launcher.showPopover(); } catch (error) { console.warn('[WorldInfo Tracker] Floating icon fallback', error); }
    }
}
function resetFloatingPosition() {
    savedPosition = null; previewPosition = null;
    try { globalThis.localStorage?.removeItem(POSITION_KEY); } catch {}
    showFloatingIcon();
}
function setFloatingSize(value) {
    floatingSize = normalizeSize(value);
    try { globalThis.localStorage?.setItem(SIZE_KEY, String(floatingSize)); } catch {}
    showFloatingIcon();
}

function buildUI() {
    if (panel) return;
    launcher = button('', () => setPanelOpen(panel.hidden), 'wit-launcher', '눌러서 열기 · 끌어서 이동');
    // Inline priorities protect the control from mobile theme rules.
    for (const [name, value] of Object.entries({ display: 'block', position: 'fixed', right: 'auto', bottom: 'auto', margin: '0', padding: '0', transform: 'none', opacity: '1', visibility: 'visible', 'pointer-events': 'auto', overflow: 'visible', 'z-index': '2147483646', background: 'transparent', border: '0', 'text-align': 'center', 'box-shadow': 'none', 'touch-action': 'none', 'user-select': 'none', cursor: 'grab' })) {
        launcher.style.setProperty(name, value, 'important');
    }
    badge = el('span', 'wit-badge'); badge.hidden = true; badge.setAttribute('aria-hidden', 'true');
    const icon = el('img', 'wit-launcher-icon');
    icon.src = new URL('./icon.png', import.meta.url).href; icon.alt = ''; icon.draggable = false;
    launcher.append(icon, badge);
    launcher.id = 'wit-floating-launcher';
    launcher.setAttribute('aria-expanded', 'false');
    detachDrag = attachFloatingDrag(launcher, {
        getPosition: () => savedPosition, getViewport: floatingViewport, getSize: () => floatingSize,
        preview: p => { previewPosition = p; showFloatingIcon(); },
        commit: p => { savedPosition = p; previewPosition = null; try { globalThis.localStorage?.setItem(POSITION_KEY, JSON.stringify(p)); } catch {} showFloatingIcon(); },
        restore: () => { previewPosition = null; showFloatingIcon(); },
    });

    panel = el('aside', 'wit-panel'); panel.hidden = true; panel.setAttribute('aria-label', TITLE);
    isolateKeys(panel);
    const header = el('header', 'wit-header'), titles = el('div');
    titles.append(el('h2', '', TITLE));
    subtitle = el('p', 'wit-muted'); titles.append(subtitle);
    header.append(titles, button('×', () => setPanelOpen(false), 'wit-close', '닫기'));
    const tabs = el('div', 'wit-tabs');
    for (const [kind, label] of [['active', '이번 응답'], ['all', '전체'], ['vars', '현재 값'], ['ai', 'AI'], ['setup', '설정']]) {
        const b = button(label, () => { tab = kind; if (kind === 'setup') fillSetup(); render(); refreshAll(); });
        b.dataset.tab = kind; tabs.append(b);
    }
    toolbar = el('div', 'wit-toolbar');
    searchInput = el('input', 'wit-search'); searchInput.type = 'search'; searchInput.placeholder = '제목 · 책 · 키워드 검색';
    searchInput.addEventListener('input', () => { search = searchInput.value; render(); });
    toolbar.append(searchInput, button('＋ 새 엔트리', () => openEditor(null), 'wit-primary', '이 방 전용 엔트리 추가'));
    // The request box lives outside the re-rendered body so typing is never interrupted.
    aiBox = el('div', 'wit-ask'); aiBox.hidden = true;
    aiInput = el('textarea', 'wit-ask-input'); aiInput.rows = 3; aiInput.setAttribute('aria-label', 'AI에게 요청');
    aiInput.placeholder = '예: 10층이 클리어되면 균열이 생기는 설정 추가해줘\n예: 2층 클리어됐어, 관련 엔트리 갱신해줘';
    aiSend = button('보내기', () => (aiBusy ? cancelAi() : askAi()), 'wit-primary');
    aiMeta = el('small', 'wit-muted');
    const askRow = el('div', 'wit-ask-row'); askRow.append(aiMeta, aiSend);
    aiTargetRow = el('div', 'wit-targets');
    aiBox.append(aiTargetRow, aiInput, askRow);
    setupBox = buildSetup();
    body = el('div', 'wit-body');
    status = el('footer', 'wit-status'); status.setAttribute('role', 'status');
    panel.append(header, tabs, toolbar, aiBox, setupBox, body, status);
    document.body.append(launcher, panel);
    showFloatingIcon();
    render();
}
// Settings tab: a persistent form, so typing is never interrupted by re-renders.
function buildSetup() {
    const box = el('div', 'wit-setup'); box.hidden = true;
    isolateKeys(box);
    const save = () => { context().saveSettingsDebounced(); render(); };
    const profile = el('select', 'wit-profile');
    profile.addEventListener('change', () => { settings().profileId = profile.value; save(); });
    const profileHint = el('small', 'wit-muted');
    const number = (name, min, max) => {
        const input = el('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = String(min); input.max = String(max);
        input.addEventListener('change', () => {
            const n = Math.round(Number(input.value));
            if (Number.isFinite(n) && input.value !== '') settings()[name] = Math.min(max, Math.max(min, n));
            input.value = String(settings()[name]); save();
        });
        return input;
    };
    const thinking = el('select', 'wit-thinking');
    thinking.append(new Option('끄기 (추천)', 'min'), new Option('낮게', 'low'), new Option('모델 기본', 'auto'));
    thinking.addEventListener('change', () => { settings().thinking = thinking.value; save(); });
    const turns = number('chatTurns', 0, 100), every = number('autoEvery', 1, 500), tokens = number('maxTokens', 256, 65536);
    const autoOn = el('input'); autoOn.type = 'checkbox'; autoOn.setAttribute('aria-label', '자동 추적');
    autoOn.addEventListener('change', async () => {
        settings().autoOn = autoOn.checked;
        // Counting starts from the moment it is switched on, not from the past.
        if (autoOn.checked && chatKey() && relocateBookmark(context().chat || [], chatState().trackAt, chatState().trackSig) === null) {
            try { await setBookmarkToEnd(chatKey()); } catch (error) { console.warn('[WorldInfo Tracker]', error); }
        }
        save();
    });
    const sendBox = el('div', 'wit-send');
    const sendChecks = [['sendCard', '캐릭터 카드'], ['sendPersona', '유저 페르소나'], ['sendNote', '작가노트']].map(([name, label]) => {
        const wrap = el('label', 'checkbox_label'), input = el('input'); input.type = 'checkbox';
        input.addEventListener('change', () => { settings()[name] = input.checked; save(); });
        wrap.append(input, el('span', '', label)); sendBox.append(wrap);
        return [name, input];
    });
    const tags = el('input'); tags.placeholder = 'Status'; tags.setAttribute('aria-label', '상태창 태그');
    tags.addEventListener('change', () => { settings().trackTags = tags.value.trim(); save(); });
    const prompt = el('textarea', 'wit-setup-prompt'); prompt.rows = 8;
    prompt.placeholder = '예: 한국어로 써줘\n예: 캐릭터 엔트리는 ## BASICS 형식을 유지해줘\n예: 타이머·날짜는 꼭 갱신해줘';
    prompt.addEventListener('input', () => { settings().customPrompt = prompt.value; context().saveSettingsDebounced(); });
    // Editable AI rules; the reply format stays locked and is only shown.
    const ruleBox = (kind, title, hint) => {
        const key = `${kind}Prompt`, defaults = RULE_DEFAULTS[kind];
        const wrap = el('div', 'wit-rules');
        const area = el('textarea', 'wit-rules-text'); area.rows = 14; area.spellcheck = false; area.setAttribute('aria-label', title);
        const count = el('small', 'wit-muted');
        const refresh = () => { count.textContent = `약 ${area.value.length.toLocaleString()}자${settings()[key] === null ? ' · 기본값' : ' · 내가 고침'}`; };
        area.addEventListener('input', () => {
            settings()[key] = area.value === defaults ? null : area.value;
            context().saveSettingsDebounced(); refresh();
        });
        const reset = button('기본값으로', () => {
            settings()[key] = null; area.value = defaults; context().saveSettingsDebounced(); refresh();
        }, 'wit-quiet', '내가 고친 내용을 지우고 기본 규칙으로 되돌려요');
        const top = el('div', 'wit-rules-top'); top.append(el('strong', '', title), reset);
        wrap.append(top, el('small', 'wit-muted', hint), area, count);
        return { wrap, fill: () => { if (document.activeElement !== area) area.value = typeof settings()[key] === 'string' ? settings()[key] : defaults; refresh(); } };
    };
    const askRules = ruleBox('ask', 'AI 탭 요청 지시문', 'AI 탭에서 요청을 보낼 때 맨 앞에 붙어요.');
    const trackRules = ruleBox('track', '자동 추적 지시문', '자동 추적과 지금 확인에 맨 앞에 붙어요.');
    const locked = el('details', 'wit-locked');
    locked.append(el('summary', '', '고정 부분 (답변 형식) 보기 · 수정할 수 없어요'), el('pre', 'wit-preview', FORMAT_LOCKED),
        el('small', 'wit-muted', '위 지시문 바로 뒤에 항상 붙어요. 확장이 이 형식으로 답을 읽어서 카드와 값 변경을 만들어요.'));
    const advanced = el('details', 'wit-advanced');
    advanced.append(el('summary', '', 'AI 지시문 (고급)'), el('small', 'wit-muted', '단어 하나로도 결과가 달라져요. 마음대로 고쳐도 되고, 답변 형식은 잠겨 있어서 망가지지 않아요. 글자 수만큼 요청마다 토큰이 들어요. 영어로 쓰는 게 가장 잘 따라요.'),
        askRules.wrap, trackRules.wrap, locked);
    const row = (label, input, unit, hint) => {
        // A group of checkboxes carries its own labels, so it can't sit inside another <label>.
        const wrap = el(input.tagName === 'DIV' ? 'div' : 'label', 'wit-setup-row');
        wrap.append(el('span', 'wit-setup-label', label), input);
        if (unit) wrap.append(el('span', 'wit-muted', unit));
        const group = el('div', 'wit-setup-group'); group.append(wrap);
        if (hint) group.append(hint instanceof Node ? hint : el('small', 'wit-muted', hint));
        return group;
    };
    box.append(
        el('h4', '', 'AI'),
        row('연결', profile, '', profileHint),
        row('생각', thinking, '', '모델의 생각(추론)에 쓰는 토큰. 끄면 훨씬 싸요. 연결 프로필로 요청할 때만 적용되고, 현재 채팅 API는 SillyTavern 설정을 따라요.'),
        row('최근 대화', turns, '턴', 'AI에게 같이 보낼 최근 메시지 수. 요청 비용의 큰 부분이에요.'),
        row('보낼 자료', sendBox, '', 'AI 탭 요청과 자동 추적에 배경 자료로 같이 보내요. 카드·노트에만 적힌 인물이나 능력도 엔트리에 반영할 수 있게 돼요. 길이만큼 요청마다 토큰이 들어요(항목당 최대 8000자).'),
        row('최대 토큰', tokens, '', 'AI 응답 길이 한도. 생각하는 모델(Gemini 등)은 생각에도 써서 넉넉해야 해요.'),
        el('h4', '', '자동 추적'),
        row('자동 추적', autoOn, '', '켜면 대화가 쌓일 때 AI가 월드인포를 확인해요. 값 변화는 바로 적용하고, 낡은 정보·새 설정은 AI 탭에 제안으로 남겨요. 켠 시점부터 세요.'),
        row('읽는 주기', every, '턴마다', '캐릭터 응답 N개마다 한 번. 최신 2턴은 확정될 때까지 기다려요. 숨긴 메시지도 읽으니 요약 확장과 상관없이 동작해요.'),
        row('상태창 태그', tags, '', '메시지마다 반복되는 <Status>…</Status> 같은 블록은 가장 최근 것만 보내서 아껴요. 비우면 끔.'),
        advanced,
        el('h4', '', '추가 지시'),
        prompt,
        el('small', 'wit-muted', 'AI에게 매번 같이 보내는 내 규칙이에요. 기본 지시는 그대로 두고 덧붙여져요. 처음 한 번 이름·개념 규칙이 미리 채워져 있어요. 자유롭게 고치거나 지워도 돼요.'),
    );
    fillSetup = () => {
        const s = settings(), list = profiles();
        profile.replaceChildren(new Option('현재 채팅 API', ''), ...list.map(p => new Option(p.name || p.id, p.id)));
        profile.value = s.profileId;
        if (profile.value !== s.profileId) profile.value = '';
        profileHint.textContent = list.length ? '월드인포 작업에만 다른 모델을 쓰고 싶을 때 연결 프로필을 고르세요.' : '연결 프로필이 없어요. SillyTavern의 연결 관리자(Connection Profiles)에서 만들 수 있어요.';
        thinking.value = s.thinking; turns.value = String(s.chatTurns); every.value = String(s.autoEvery); tokens.value = String(s.maxTokens);
        askRules.fill(); trackRules.fill();
        for (const [name, input] of sendChecks) input.checked = Boolean(s[name]);
        autoOn.checked = Boolean(s.autoOn); if (document.activeElement !== tags) tags.value = s.trackTags;
        if (document.activeElement !== prompt) prompt.value = s.customPrompt;
    };
    profile.addEventListener('focus', fillSetup);
    return box;
}
function buildSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('wit-settings')) return;
    const wrap = el('div'); wrap.id = 'wit-settings';
    // SillyTavern's native drawer markup, so themes match.
    const drawer = el('div', 'inline-drawer');
    const header = el('div', 'inline-drawer-toggle inline-drawer-header');
    header.append(el('b', '', TITLE), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = el('div', 'inline-drawer-content');
    const actions = el('div', 'flex-container');
    actions.append(button('패널 열기', () => setPanelOpen(true), 'menu_button'), button('아이콘 위치 초기화', resetFloatingPosition, 'menu_button'));
    const show = el('input'); show.type = 'checkbox'; show.checked = settings().showIcon;
    show.addEventListener('change', () => { settings().showIcon = show.checked; context().saveSettingsDebounced(); showFloatingIcon(); });
    const showRow = el('label', 'checkbox_label'); showRow.append(show, el('span', '', '떠 있는 아이콘 표시'));
    const size = el('input'); size.type = 'range'; size.min = '24'; size.max = '72'; size.step = '1'; size.value = String(floatingSize);
    size.addEventListener('input', () => setFloatingSize(size.value));
    const sizeRow = el('label', 'wit-size', '아이콘 크기'); sizeRow.append(size);
    content.append(actions, showRow, sizeRow,
        el('small', '', 'AI 연결·프롬프트는 패널의 설정 탭에서 정해요. 마법봉(🪄) 메뉴에서도 열 수 있어요.'));
    drawer.append(header, content); wrap.append(drawer); host.append(wrap);
}
function buildMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('wit-menu-item')) return;
    const item = el('div', 'list-group-item flex-container flexGap5 interactable');
    item.id = 'wit-menu-item'; item.tabIndex = 0;
    item.append(el('div', 'fa-solid fa-book-open extensionsMenuExtensionButton'), el('span', '', TITLE));
    item.addEventListener('click', () => setPanelOpen(true));
    menu.append(item);
}

function init() {
    if (!active) return;
    buildUI(); buildSettings(); buildMenuItem();
    if (!generation) result = loadLast(chatKey());
    showFloatingIcon(); render();
}

export function onEnable() {
    if (active) return;
    active = true;
    globalThis.addEventListener?.('resize', showFloatingIcon);
    globalThis.visualViewport?.addEventListener('resize', showFloatingIcon);
    listen(event_types.WORLDINFO_ENTRIES_LOADED, payload => {
        const state = chatState();
        for (const list of Object.values(payload)) if (Array.isArray(list)) for (const e of list) fileOn.set(entryKey(e.world, e.uid), !e.disable);
        // Hide shared entries that this chat replaced with its own copy, then apply this chat's ON/OFF.
        applyReplacements(payload, state.replaced);
        applyToggles(payload, state.toggles);
    });
    listen(event_types.GENERATION_AFTER_COMMANDS, (type, _options, dryRun) => {
        if (dryRun || type === 'quiet' || !chatKey()) return;
        generation = { chat: chatKey(), type };
        result = { chat: generation.chat, phase: 'pending', entries: [] };
        render();
    });
    listen(event_types.WORLD_INFO_ACTIVATED, entries => {
        if (!generation || generation.chat !== chatKey() || result.phase !== 'pending') return;
        try { setReady(capture(entries)); } catch (error) { console.warn('[WorldInfo Tracker] Capture failed', error); }
        render();
    });
    // Reaching the API payload proves the prompt was built; with no activation event that means zero entries.
    listen(event_types.GENERATE_AFTER_DATA, (_data, dryRun) => {
        if (!dryRun && generation && result.phase === 'pending' && generation.chat === chatKey()) { setReady([]); render(); }
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) listen(event_types[name], () => {
        if (result.phase === 'pending') result = loadLast(chatKey());
        generation = null; render();
        if (name === 'GENERATION_ENDED') setTimeout(maybeAutoTrack, 300);
    });
    listen(event_types.CHAT_CHANGED, () => {
        generation = null; result = loadLast(chatKey());
        allEntries = []; allChat = ''; allError = ''; allToken++; fileOn.clear();
        if (aiBusy) cancelAi();
        aiError = ''; aiNote = ''; trackRetryAt = 0; aiTargets.clear();
        closeDialog(); scheduleRefresh();
    });
    for (const name of ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'CHARACTER_EDITED']) listen(event_types[name], scheduleRefresh);
    loadSharedServices();
    listen(event_types.APP_READY, init);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
}
export function onDisable() {
    active = false;
    detachDrag?.(); detachDrag = null;
    globalThis.removeEventListener?.('resize', showFloatingIcon);
    globalThis.visualViewport?.removeEventListener('resize', showFloatingIcon);
    for (const [name, handler] of subscriptions.splice(0)) eventSource.removeListener(name, handler);
    document.removeEventListener('DOMContentLoaded', init);
    clearTimeout(refreshTimer); allToken++;
    closeDialog();
    panel?.remove(); launcher?.remove();
    document.getElementById('wit-settings')?.remove(); document.getElementById('wit-menu-item')?.remove();
    aiAbort?.abort(); aiBusy = false; aiAbort = null; aiError = ''; aiNote = '';
    panel = null; launcher = null; badge = null; generation = null;
    result = { chat: '', phase: 'unknown', entries: [] }; allEntries = []; allChat = '';
}
onEnable();
