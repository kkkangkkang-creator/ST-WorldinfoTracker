// Run with Playwright installed: node tests/browser.cjs [screenshot-dir]
// Loads the real extension against mocked SillyTavern modules and clicks through the main flows.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const shots = process.argv[2];
const prefix = '/scripts/extensions/third-party/ST-WorldinfoTracker/';

const scriptMock = `
export const event_types = Object.fromEntries(['APP_READY','GENERATION_AFTER_COMMANDS','GENERATE_AFTER_DATA','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED','WORLDINFO_ENTRIES_LOADED','WORLD_INFO_ACTIVATED','CHARACTER_EDITED'].map(x => [x, x]));
const listeners = {};
export const eventSource = {
    on: (n, f) => (listeners[n] ??= []).push(f),
    removeListener: (n, f) => { listeners[n] = (listeners[n] || []).filter(x => x !== f); },
    emit: async (n, ...a) => { for (const f of [...listeners[n] || []]) await f(...a); },
};
export const isGenerating = () => window.busy || false;
window.eventSource = eventSource;
`;
const worldInfoMock = `
import { eventSource } from '/script.js';
export const METADATA_KEY = 'world_info';
export const newWorldInfoEntryTemplate = { key: [], keysecondary: [], comment: '', content: '', constant: false, disable: false, order: 100, position: 0 };
export let world_info_depth = 2, world_info_case_sensitive = false, world_info_match_whole_words = false, world_info_include_names = true, world_info_recursive = false;
const listOf = name => Object.values(window.books[name]?.entries || {}).map(e => ({ ...structuredClone(e), world: name }));
export async function getSortedEntries() {
    const chatBook = window.SillyTavern.getContext().chatMetadata.world_info;
    const payload = { globalLore: listOf('AU'), characterLore: [], chatLore: chatBook ? listOf(chatBook) : [], personaLore: [] };
    await eventSource.emit('WORLDINFO_ENTRIES_LOADED', payload);
    return [...payload.chatLore, ...payload.globalLore];
}
`;
// getContext() in the mock lacks the profile service, like older SillyTavern builds.
const sharedMock = `
export const ConnectionManagerRequestService = {
    isProfileSupported: p => p.api === 'openai',
    sendRequest: async (id, messages) => { window.profileCall = id; window.aiPrompt = messages; return { content: window.aiReply }; },
};
`;
const page0 = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css"></head><body>
<div id="extensions_settings"></div><div id="extensionsMenu"></div>
<script>
window.books = { AU: { entries: {
    0: { uid: 0, comment: '성좌 헌터물', key: [], content: 'World...', constant: true, disable: true, order: 100 },
    2: { uid: 2, comment: '헌터물 기본 설정 보강', key: [], content: 'Around two weeks remain. roughly two weeks remaining.', constant: true, disable: true, order: 101 },
    5: { uid: 5, comment: '탑 내부', key: ['탑', 'tower'], keysecondary: ['2층'], content: 'Inside the tower', constant: false, disable: false },
} } };
const chats = { A: {}, B: {} }, store = new Map();
const extensionSettings = { disabledExtensions: [], connectionManager: { profiles: [{ id: 'p1', name: 'Flash', api: 'openai' }, { id: 'p2', name: 'Novel', api: 'novel' }] } };
window.extensionSettings = extensionSettings;
window.currentChat = 'A';
window.chat = [{ name: 'User', mes: '탑 2층 공략은 언제야?' }, { name: 'Lena', mes: '아직 몰라.' }];
window.SillyTavern = {
    libs: { localforage: { getItem: async k => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, structuredClone(v)); } } },
    getContext: () => ({
        extensionSettings, saveSettingsDebounced: () => {},
        chatMetadata: chats[window.currentChat], saveMetadata: async () => {},
        getCurrentChatId: () => window.currentChat, characters: [{ avatar: 'lena.png' }], characterId: 0,
        chat: window.chat, substituteParams: x => x,
        loadWorldInfo: async n => window.books[n] ? structuredClone(window.books[n]) : null,
        saveWorldInfo: async (n, d) => { window.books[n] = structuredClone(d); },
        updateWorldInfoList: async () => {}, reloadWorldInfoEditor: () => {},
        getWorldInfoNames: () => Object.keys(window.books),
        Popup: { show: { confirm: async () => 1 } },
        generateRaw: async ({ prompt }) => { window.aiPrompt = prompt; await new Promise(r => setTimeout(r, 50)); return window.aiReply; },
    }),
};
window.chats = chats; window.store = store;
</script>
<script type="module" src="${prefix}index.js"></script></body></html>`;

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('http://st.test/**', route => {
        const url = new URL(route.request().url());
        const body = url.pathname === '/scripts/extensions/shared.js' ? sharedMock : url.pathname === '/' ? page0 : url.pathname === '/script.js' ? scriptMock : url.pathname === '/scripts/world-info.js' ? worldInfoMock
            : url.pathname.startsWith(prefix) ? fs.readFileSync(path.join(root, url.pathname.slice(prefix.length)), 'utf8') : null;
        if (body === null) return route.fulfill({ status: 404, body: '' });
        const type = url.pathname.endsWith('.css') ? 'text/css' : url.pathname === '/' ? 'text/html' : 'text/javascript';
        return route.fulfill({ status: 200, contentType: type, body });
    });
    await page.goto('http://st.test/');
    await page.waitForSelector('#wit-floating-launcher');

    // 1. A generation activates two entries.
    await page.evaluate(async () => {
        const e = window.eventSource, au = window.books.AU.entries;
        await e.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        await e.emit('WORLD_INFO_ACTIVATED', [{ ...au[2], world: 'AU', disable: false }, { ...au[5], world: 'AU' }]);
        await e.emit('GENERATE_AFTER_DATA', {}, false);
        await e.emit('GENERATION_ENDED');
    });
    assert.equal(await page.textContent('.wit-badge'), '2');
    await page.click('#wit-floating-launcher');
    await page.waitForSelector('.wit-row');
    const rows = await page.$$eval('.wit-row', r => r.map(x => x.textContent));
    assert.ok(rows.some(t => t.includes('헌터물 기본 설정 보강') && t.includes('상시')), rows.join(' | '));
    assert.deepEqual(await page.$$eval('.wit-key', k => k.map(x => x.textContent)), ['탑', '2층']);
    if (shots) await page.screenshot({ path: path.join(shots, '1-active.png') });

    // 2. Edit the shared timer entry for this chat only.
    await page.click('.wit-row >> text=헌터물 기본 설정 보강');
    await page.waitForSelector('.wit-dialog');
    await page.fill('.wit-replace input >> nth=0', 'two weeks');
    await page.fill('.wit-replace input >> nth=1', '9 days');
    await page.click('.wit-dialog button >> text=바꾸기');
    assert.match(await page.textContent('.wit-dialog'), /2곳 바꿨어요/);
    if (shots) await page.screenshot({ path: path.join(shots, '2-editor.png') });
    await page.click('.wit-dialog button >> text=이 방에만 저장');
    await page.waitForSelector('.wit-dialog', { state: 'detached' });
    let state = await page.evaluate(() => ({ books: window.books, meta: window.chats.A }));
    const book = state.meta.world_info;
    assert.ok(book.startsWith('이 방 전용 · A'), book);
    assert.equal(state.books.AU.entries[2].content, 'Around two weeks remain. roughly two weeks remaining.', 'shared book untouched');
    const copy = Object.values(state.books[book].entries)[0];
    assert.equal(copy.content, 'Around 9 days remain. roughly 9 days remaining.');
    assert.equal(copy.disable, false, 'copy follows the effective ON state');
    assert.equal(copy.order, 101);
    assert.deepEqual(state.meta.worldinfo_tracker.replaced, [{ world: 'AU', uid: 2, book, copyUid: 0 }]);

    // 3. In this chat the original is hidden and the copy loads instead.
    let loaded = await page.evaluate(async () => (await import('/scripts/world-info.js')).getSortedEntries().then(l => l.map(e => `${e.world}#${e.uid}`)));
    assert.deepEqual(loaded, [`${book}#0`, 'AU#0', 'AU#5']);
    await page.click('.wit-tabs button[data-tab=all]');
    await page.waitForSelector('.wit-tag >> text=수정본');
    if (shots) await page.screenshot({ path: path.join(shots, '3-all.png') });

    // 4. Clicking the stale original in "이번 응답" opens the copy, not a second copy.
    await page.click('.wit-tabs button[data-tab=active]');
    await page.click('.wit-row >> text=헌터물 기본 설정 보강');
    await page.waitForSelector('.wit-dialog');
    assert.match(await page.textContent('.wit-where'), /현재: 📗 이 방 전용 · 원본 AU/);

    // 5. Revert the copy.
    await page.click('.wit-dialog button >> text=원본으로 되돌리기');
    await page.waitForSelector('.wit-dialog', { state: 'detached' });
    state = await page.evaluate(() => ({ books: window.books, meta: window.chats.A }));
    assert.deepEqual(state.books[book].entries, {});
    assert.deepEqual(state.meta.worldinfo_tracker.replaced, []);

    // 6. Add a new chat-only entry.
    await page.click('.wit-toolbar button >> text=＋ 새 엔트리');
    await page.fill('.wit-dialog .wit-field >> nth=0 >> input', '균열');
    await page.fill('.wit-dialog .wit-field >> nth=1 >> input', '균열, rift');
    await page.fill('.wit-dialog textarea.wit-content', '## Rifts (not yet occurred)');
    await page.click('.wit-modes button[data-mode=constant]');
    await page.fill('.wit-settings-row input >> nth=0', '50');
    await page.fill('.wit-settings-row input >> nth=1', '70');
    await page.click('.wit-dialog button >> text=이 방에 추가');
    await page.waitForSelector('.wit-dialog', { state: 'detached' });
    state = await page.evaluate(() => window.books);
    assert.deepEqual(Object.values(state[book].entries).map(e => [e.comment, e.key, e.content, e.constant, e.vectorized, e.order, e.probability, e.useProbability]),
        [['균열', ['균열', 'rift'], '## Rifts (not yet occurred)', true, false, 50, 70, true]]);

    // Phone width: a long entry still shows the save buttons without scrolling the dialog.
    await page.setViewportSize({ width: 390, height: 760 });
    await page.click('.wit-tabs button[data-tab=all]');
    await page.click('.wit-row >> text=헌터물 기본 설정 보강');
    await page.waitForSelector('.wit-dialog');
    await page.fill('.wit-dialog textarea.wit-content', 'line\n'.repeat(200));
    const footer = await page.$eval('.wit-modal-footer', f => { const r = f.getBoundingClientRect(); return { bottom: r.bottom, h: innerHeight }; });
    assert.ok(footer.bottom <= footer.h, JSON.stringify(footer));
    if (shots) await page.screenshot({ path: path.join(shots, '5-phone-editor.png') });
    await page.click('.wit-dialog button >> text=닫기');
    await page.setViewportSize({ width: 1100, height: 800 });

    // 7. Another chat is unaffected; saving to the shared book there keeps a backup.
    await page.evaluate(async () => { window.currentChat = 'B'; await window.eventSource.emit('CHAT_CHANGED'); });
    loaded = await page.evaluate(async () => (await import('/scripts/world-info.js')).getSortedEntries().then(l => l.map(e => `${e.world}#${e.uid}`)));
    assert.deepEqual(loaded, ['AU#0', 'AU#2', 'AU#5']);
    await page.click('.wit-tabs button[data-tab=all]');
    await page.click('.wit-row >> text=탑 내부');
    await page.waitForSelector('.wit-dialog');
    await page.fill('.wit-dialog textarea.wit-content', 'Inside the tower (edited)');
    await page.click('.wit-dialog button >> text=공용 책에 저장');
    await page.waitForSelector('.wit-dialog', { state: 'detached' });
    state = await page.evaluate(() => ({ books: window.books, backups: [...window.store.keys()] }));
    assert.equal(state.books.AU.entries[5].content, 'Inside the tower (edited)');
    assert.equal(state.backups.length, 1);

    // 8. Chat-only ON/OFF: chat B turns "탑 내부" off; chat A keeps it on; toggling back clears the override.
    await page.click('.wit-dialog button >> text=닫기').catch(() => {});
    const sortedOf = () => page.evaluate(async () => (await import('/scripts/world-info.js')).getSortedEntries().then(l => Object.fromEntries(l.map(e => [`${e.world}#${e.uid}`, !e.disable]))));
    await sortedOf(); // records the books' own ON/OFF
    await page.click('.wit-row:has-text("탑 내부") .wit-switch');
    await page.waitForSelector('.wit-row:has-text("탑 내부") .wit-switch.is-chat >> text=OFF');
    assert.deepEqual(await page.evaluate(() => window.chats.B.worldinfo_tracker.toggles), { '["AU","5"]': false });
    assert.equal((await sortedOf())['AU#5'], false);
    assert.equal(await page.evaluate(() => window.books.AU.entries[5].disable), false, 'book file untouched');
    await page.click('.wit-row:has-text("탑 내부") .wit-switch');
    await page.waitForSelector('.wit-row:has-text("탑 내부") .wit-switch.is-on:not(.is-chat)');
    assert.deepEqual(await page.evaluate(() => window.chats.B.worldinfo_tracker.toggles), {});
    await page.click('.wit-row:has-text("헌터물 기본 설정 보강") .wit-switch');
    await page.waitForSelector('.wit-row:has-text("헌터물 기본 설정 보강") .wit-switch.is-on');
    assert.equal((await sortedOf())['AU#2'], true);
    if (shots) await page.screenshot({ path: path.join(shots, '6-toggles.png') });
    await page.evaluate(async () => { window.currentChat = 'A'; await window.eventSource.emit('CHAT_CHANGED'); });
    assert.equal((await sortedOf())['AU#5'], true);
    await page.evaluate(async () => { window.currentChat = 'B'; await window.eventSource.emit('CHAT_CHANGED'); });

    // 9. Generating blocks saves.
    await page.click('.wit-row >> text=탑 내부');
    await page.evaluate(() => { window.busy = true; });
    await page.click('.wit-dialog button >> text=공용 책에 저장');
    assert.equal(await page.evaluate(() => window.books.AU.entries[5].content), 'Inside the tower (edited)');
    await page.evaluate(() => { window.busy = false; });

    // 10. AI: request -> proposals -> apply. Chat B has no chat book yet.
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        window.aiReply = JSON.stringify({ proposals: [
            { action: 'create', comment: '균열', keys: ['균열', 'rift'], content: '## Rifts (not yet occurred)\n- Only after a 10th floor is cleared.', reason: '균열 설정 추가' },
            { action: 'update', world: 'AU', uid: 2, comment: '헌터물 기본 설정 보강', keys: [], content: 'Around 9 days remain. roughly 9 days remaining.', reason: '타이머 갱신' },
            { action: 'update', world: 'AU', uid: 0, content: 'made up', reason: 'not shown in full' },
        ] });
    });
    await page.click('.wit-tabs button[data-tab=ai]');
    await page.fill('.wit-ask-input', '헌터물 기본 설정 보강 타이머 9일로, 균열 설정 추가해줘');
    await page.click('.wit-ask button >> text=보내기');
    await page.waitForSelector('.wit-card >> nth=1');
    const prompt = await page.evaluate(() => window.aiPrompt);
    assert.equal(prompt[0].role, 'system');
    assert.match(prompt[1].content, /### \[AU #2\] 헌터물 기본 설정 보강/);
    assert.doesNotMatch(prompt[1].content, /### \[AU #0\]/);
    assert.equal(await page.$$eval('.wit-card', c => c.length), 2, 'update of an unseen entry is dropped');
    assert.equal(await page.textContent('.wit-tabs button[data-tab=ai]'), 'AI 2');
    assert.deepEqual(await page.$$eval('.wit-diff-add', d => d.map(x => x.textContent)), ['Around 9 days remain. roughly 9 days remaining.']);
    if (shots) await page.screenshot({ path: path.join(shots, '7-ai.png') });
    await page.click('.wit-card:has-text("타이머 갱신") button >> text=이 방에만 적용');
    await page.waitForFunction(() => document.querySelectorAll('.wit-card').length === 1);
    let bState = await page.evaluate(() => ({ books: window.books, meta: window.chats.B }));
    const bBook = bState.meta.world_info;
    assert.equal(bState.books.AU.entries[2].content, 'Around two weeks remain. roughly two weeks remaining.');
    assert.equal(Object.values(bState.books[bBook].entries)[0].content, 'Around 9 days remain. roughly 9 days remaining.');
    assert.equal(bState.meta.worldinfo_tracker.proposals.length, 1);
    // "고쳐서 적용" opens the editor with the draft; saving drops the proposal.
    await page.click('.wit-card button >> text=고쳐서 적용');
    await page.waitForSelector('.wit-dialog');
    assert.equal(await page.inputValue('.wit-dialog .wit-field >> nth=0 >> input'), '균열');
    await page.fill('.wit-dialog .wit-field >> nth=0 >> input', '균열 (Rift)');
    await page.click('.wit-dialog button >> text=이 방에 추가');
    await page.waitForFunction(() => document.querySelectorAll('.wit-card').length === 0);
    bState = await page.evaluate(() => ({ books: window.books, meta: window.chats.B }));
    assert.deepEqual(Object.values(bState.books[bBook].entries).map(e => e.comment), ['헌터물 기본 설정 보강', '균열 (Rift)']);
    assert.deepEqual(bState.meta.worldinfo_tracker.proposals, []);
    // A broken reply shows an error, keeps the request text.
    await page.evaluate(() => { window.aiReply = 'sorry, I cannot'; });
    await page.fill('.wit-ask-input', '아무거나');
    await page.click('.wit-ask button >> text=보내기');
    await page.waitForSelector('.wit-error');
    assert.equal(await page.inputValue('.wit-ask-input'), '아무거나');

    // 11. Settings tab: profile list falls back to shared.js, extra instructions reach the AI.
    await page.click('.wit-tabs button[data-tab=setup]');
    await page.waitForSelector('.wit-setup:not([hidden])');
    assert.deepEqual(await page.$$eval('.wit-setup select option', o => o.map(x => x.textContent)), ['현재 채팅 API', 'Flash']);
    await page.selectOption('.wit-setup select', 'p1');
    await page.fill('.wit-setup-prompt', '한국어로 써줘');
    const numbers = await page.$$('.wit-setup input[type=number]');
    await numbers[1].fill('2'); await numbers[1].press('Tab');
    assert.deepEqual(await page.evaluate(() => { const s = window.extensionSettings.worldinfo_tracker; return [s.profileId, s.customPrompt, s.autoEvery]; }), ['p1', '한국어로 써줘', 2]);
    if (shots) await page.screenshot({ path: path.join(shots, '8-setup.png') });
    await page.click('.wit-tabs button[data-tab=ai]');
    assert.match(await page.textContent('.wit-ask-row small'), /Flash · 최근 대화 10턴 · 2챗마다 자동/);
    await page.evaluate(() => { window.aiReply = '{"proposals":[]}'; });
    await page.fill('.wit-ask-input', '확인');
    await page.click('.wit-ask button >> text=보내기');
    await page.waitForFunction(() => window.profileCall === 'p1');
    assert.match(await page.evaluate(() => window.aiPrompt[0].content), /Additional instructions from the user[\s\S]*한국어로 써줘$/);
    await page.waitForFunction(() => document.querySelector('.wit-ask button')?.textContent === '보내기');

    // 12. Automatic proposals every 2 chat messages; swipes (no new message) don't count.
    await page.evaluate(() => { window.profileCall = null; window.aiReply = JSON.stringify({ proposals: [{ action: 'create', comment: '자동 엔트리', keys: ['x'], content: 'auto' }] }); });
    const endGeneration = () => page.evaluate(async () => { await window.eventSource.emit('GENERATION_ENDED'); await new Promise(r => setTimeout(r, 400)); });
    await endGeneration(); // first sight sets the starting point
    assert.equal(await page.evaluate(() => window.chats.B.worldinfo_tracker.autoAt), 2);
    await page.evaluate(() => window.chat.push({ name: 'User', mes: '1' }));
    await endGeneration();
    assert.equal(await page.evaluate(() => window.profileCall), null);
    await page.evaluate(() => window.chat.push({ name: 'Lena', mes: '2' }));
    await endGeneration();
    await page.waitForSelector('.wit-card .wit-tag >> text=자동');
    assert.match(await page.evaluate(() => window.aiPrompt[1].content), /## REQUEST\n\nAutomatic check/);
    assert.equal(await page.evaluate(() => window.chats.B.worldinfo_tracker.autoAt), 4);

    // Phone width.
    await page.setViewportSize({ width: 390, height: 760 });
    if (shots) await page.screenshot({ path: path.join(shots, '4-phone.png') });

    assert.deepEqual(errors, []);
    await browser.close();
    console.log('browser flows ok');
})().catch(error => { console.error(error); process.exit(1); });
