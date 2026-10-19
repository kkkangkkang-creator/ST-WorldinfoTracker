import { eventSource, event_types, isGenerating } from '../../../../script.js';
import {
    getSortedEntries, METADATA_KEY, newWorldInfoEntryTemplate,
    world_info_depth, world_info_case_sensitive, world_info_match_whole_words, world_info_include_names, world_info_recursive,
} from '../../../world-info.js';
import {
    KEY, entryKey, scanMessages, explainEntry, recursionText, applyReplacements, applyToggles,
    freeUid, buildCopy, chatBookName, formatKeys, parseKeys, countOccurrences,
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
let panel, body, status, subtitle, launcher, badge, dialog, searchInput, detachDrag;
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
    return { replaced, toggles };
}
async function writeChatState(update, key) {
    const c = context();
    if (key !== chatKey() || !c.chatMetadata) throw new Error('채팅이 바뀌어 저장하지 않았어요.');
    const next = chatState();
    update(next);
    c.chatMetadata[KEY] = next;
    await c.saveMetadata();
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

async function openEditor(item) {
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
    const d = modal(item ? '엔트리 수정' : '새 엔트리 · 이 방 전용');

    const main = el('div', 'wit-dialog-body');
    const where = el('p', 'wit-where');
    if (!item) where.textContent = `현재: 📗 이 방 전용${book ? ` · ${book}` : ' · 저장할 때 책을 만들어요'}`;
    else if (inChatBook) where.textContent = `현재: 📗 이 방 전용${rep ? ` · 원본 ${rep.world}` : ` · ${item.world}`}`;
    else where.textContent = `현재: 📘 ${item.world} · 공용`;
    main.append(where);

    const title = el('input'); title.value = raw?.comment ?? '';
    const keys = el('input'); keys.value = formatKeys(raw?.key); keys.placeholder = '쉼표로 구분';
    const keys2 = el('input'); keys2.value = formatKeys(raw?.keysecondary);
    main.append(field('제목', title), field('키워드', keys), field('보조', keys2));

    // Activation mode, order and probability on one row.
    let mode = raw?.constant ? 'constant' : raw?.vectorized ? 'vectorized' : 'keyword';
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

    const content = el('textarea', 'wit-content'); content.rows = 10; content.value = raw?.content ?? ''; content.setAttribute('aria-label', '본문');
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
    const finish = ok => { if (ok) { closeDialog(); scheduleRefresh(); } };
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
        const backup = await readBackup(item.world, item.uid);
        if (backup && dialog === d) footer.append(button('저장 전 내용 불러오기', () => {
            title.value = backup.comment; keys.value = formatKeys(backup.key); keys2.value = formatKeys(backup.keysecondary);
            content.value = backup.content;
            notify('마지막 저장 직전 내용을 불러왔어요. 저장해야 반영돼요.');
        }, 'wit-quiet'));
    }
    d.append(footer);
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
    body.append(el('p', 'wit-note', `이번 응답에 들어간 엔트리 ${result.entries.length}개 · 키워드는 추정 · ON/OFF는 이 채팅만, 다음 응답부터`));
    if (!result.entries.length) { body.append(el('p', 'wit-empty', '활성화된 엔트리가 없어요.')); return; }
    renderEntries(result.entries);
}
function renderAll() {
    if (allError) { body.append(el('p', 'wit-error', allError)); return; }
    if (allChat !== chatKey()) { body.append(el('p', 'wit-empty', '불러오는 중…')); return; }
    body.append(el('p', 'wit-note', `이 채팅에 연결된 엔트리 ${allEntries.length}개 · ON/OFF는 이 채팅만`));
    renderEntries(allEntries);
}
function render() {
    updateBadge();
    if (!panel || panel.hidden) return;
    const book = chatBook();
    subtitle.textContent = chatKey() ? (book ? `이 방 전용 책: ${book}` : '이 방 전용 책: 아직 없음 · 처음 저장할 때 만들어요') : '채팅을 열어주세요';
    for (const b of panel.querySelectorAll('.wit-tabs button')) b.classList.toggle('is-active', b.dataset.tab === tab);
    body.replaceChildren();
    if (!chatKey()) body.append(el('p', 'wit-empty', '채팅을 열어주세요.'));
    else if (tab === 'active') renderActive();
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
    if (!active || !chatKey() || !panel || panel.hidden || tab !== 'all') return;
    const token = ++allToken, key = chatKey();
    try {
        const list = await getSortedEntries();
        if (token !== allToken || key !== chatKey()) return;
        allEntries = list.map(e => ({ world: e.world, uid: e.uid, comment: e.comment, key: e.key, keysecondary: e.keysecondary, constant: e.constant, vectorized: e.vectorized, disable: e.disable }));
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
    launcher.append(el('span', '', '📖'), badge);
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
    for (const [kind, label] of [['active', '이번 응답'], ['all', '전체 엔트리']]) {
        const b = button(label, () => { tab = kind; render(); refreshAll(); });
        b.dataset.tab = kind; tabs.append(b);
    }
    const toolbar = el('div', 'wit-toolbar');
    searchInput = el('input', 'wit-search'); searchInput.type = 'search'; searchInput.placeholder = '제목 · 책 · 키워드 검색';
    searchInput.addEventListener('input', () => { search = searchInput.value; render(); });
    toolbar.append(searchInput, button('＋ 새 엔트리', () => openEditor(null), 'wit-primary', '이 방 전용 엔트리 추가'));
    body = el('div', 'wit-body');
    status = el('footer', 'wit-status'); status.setAttribute('role', 'status');
    panel.append(header, tabs, toolbar, body, status);
    document.body.append(launcher, panel);
    showFloatingIcon();
    render();
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
    const showRow = el('label', 'checkbox_label'); showRow.append(show, el('span', '', '떠 있는 📖 아이콘 표시'));
    const size = el('input'); size.type = 'range'; size.min = '24'; size.max = '72'; size.step = '1'; size.value = String(floatingSize);
    size.addEventListener('input', () => setFloatingSize(size.value));
    const sizeRow = el('label', 'wit-size', '아이콘 크기'); sizeRow.append(size);
    content.append(actions, showRow, sizeRow, el('small', '', '마법봉(🪄) 메뉴에서도 열 수 있어요.'));
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
    showFloatingIcon();
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
        try { result = { chat: generation.chat, phase: 'ready', entries: capture(entries) }; } catch (error) { console.warn('[WorldInfo Tracker] Capture failed', error); }
        render();
    });
    // Reaching the API payload proves the prompt was built; with no activation event that means zero entries.
    listen(event_types.GENERATE_AFTER_DATA, (_data, dryRun) => {
        if (!dryRun && generation && result.phase === 'pending' && generation.chat === chatKey()) { result.phase = 'ready'; render(); }
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) listen(event_types[name], () => {
        if (result.phase === 'pending') result.phase = 'unknown';
        generation = null; render();
    });
    listen(event_types.CHAT_CHANGED, () => {
        generation = null; result = { chat: '', phase: 'unknown', entries: [] };
        allEntries = []; allChat = ''; allError = ''; allToken++; fileOn.clear();
        closeDialog(); scheduleRefresh();
    });
    for (const name of ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED', 'CHARACTER_EDITED']) listen(event_types[name], scheduleRefresh);
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
    panel = null; launcher = null; badge = null; generation = null;
    result = { chat: '', phase: 'unknown', entries: [] }; allEntries = []; allChat = '';
}
onEnable();
