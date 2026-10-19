import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
    keyMatches, scanMessages, explainEntry, recursionText, applyReplacements, applyToggles,
    freeUid, buildCopy, chatBookName, formatKeys, parseKeys, countOccurrences, entryKey,
    pickDetails, buildAiMessages, recentChatLines, parseProposals, lineDiff, applyEdits,
} from '../core.mjs';

const globals = { depth: 2, caseSensitive: false, matchWholeWords: false };

test('keyword matching follows ST rules', () => {
    assert.ok(keyMatches('레나: 균열이 열렸어', '균열', {}, globals));
    assert.ok(keyMatches('The RIFT opened', 'rift', {}, globals));
    assert.ok(!keyMatches('The RIFT opened', 'rift', { caseSensitive: true }, globals));
    assert.ok(!keyMatches('drifting away', 'rift', { matchWholeWords: true }, globals));
    assert.ok(keyMatches('a rift, again', 'rift', { matchWholeWords: true }, globals));
    assert.ok(keyMatches('floor 2 timer', '/floor\\s*\\d/i', {}, globals));
});

test('scan messages are newest first, skip system lines and the swiped reply', () => {
    const chat = [
        { name: 'User', mes: 'hello' },
        { name: 'Narrator', mes: 'note', is_system: true },
        { name: 'Lena', mes: 'old reply' },
    ];
    assert.deepEqual(scanMessages(chat), ['Lena: old reply', 'User: hello']);
    assert.deepEqual(scanMessages(chat, { type: 'swipe', includeNames: false }), ['hello']);
});

test('explains matched keys within scan depth, then recursion', () => {
    const messages = ['User: 균열 소식 들었어?', 'Lena: 아니', 'User: 탑 2층 얘기'];
    const rift = { key: ['균열', 'rift'], keysecondary: [] };
    assert.deepEqual(explainEntry(rift, { messages, globals }).primary, ['균열']);
    const tower = { key: ['2층'] };
    // "2층" is only at depth 3, outside the global depth of 2.
    assert.equal(explainEntry(tower, { messages, globals }).source, 'unknown');
    assert.deepEqual(explainEntry({ ...tower, scanDepth: 3 }, { messages, globals }).primary, ['2층']);
    const viaRecursion = explainEntry(tower, { messages, globals, recursion: '2층 타이머가 14일 남음' });
    assert.equal(viaRecursion.source, 'recursion');
    assert.equal(explainEntry({ constant: true, key: [] }, { messages, globals }).mode, 'constant');
    assert.deepEqual(explainEntry({ key: ['{{char}}'] }, { messages: ['User: Lena!'], globals, substitute: x => x.replace('{{char}}', 'Lena') }).primary, ['{{char}}']);
});

test('recursion text skips self and preventRecursion entries', () => {
    const a = { content: 'A' }, b = { content: 'B', preventRecursion: true }, c = { content: 'C' };
    assert.equal(recursionText([a, b, c], a), 'C');
});

test('replacements hide the original only while its copy exists', () => {
    const payload = {
        globalLore: [{ world: 'AU', uid: 2 }, { world: 'AU', uid: 3 }],
        characterLore: [],
        chatLore: [{ world: 'room', uid: 0 }],
        personaLore: [],
    };
    const keep = payload.globalLore;
    const removed = applyReplacements(payload, [
        { world: 'AU', uid: 2, book: 'room', copyUid: 0 },
        { world: 'AU', uid: 3, book: 'room', copyUid: 9 }, // copy deleted -> original stays
    ]);
    assert.equal(removed, 1);
    assert.equal(payload.globalLore, keep, 'array identity is kept for ST');
    assert.deepEqual(payload.globalLore.map(x => x.uid), [3]);
    assert.equal(applyReplacements(payload, []), 0);
});

test('copies keep settings, take the effective ON/OFF, and drop the world field', () => {
    const raw = { uid: 2, world: 'AU', comment: 'Towers', content: 'two weeks', order: 101, disable: true, constant: true };
    const copy = buildCopy(raw, { disable: false }, 5, { content: '9 days' });
    assert.deepEqual(copy, { uid: 5, comment: 'Towers', content: '9 days', order: 101, disable: false, constant: true, displayIndex: 5 });
    assert.equal(raw.content, 'two weeks');
    assert.equal(freeUid({ entries: { 0: {}, 1: {}, 3: {} } }), 2);
    assert.equal(freeUid({}), 0);
});

test('chat book names are file-safe and unique', () => {
    const taken = new Set(['이 방 전용 · Lena - 2026-10-19@10h']);
    assert.equal(chatBookName('Lena - 2026-10-19@10h', n => taken.has(n)), '이 방 전용 · Lena - 2026-10-19@10h (2)');
    assert.equal(chatBookName('a/b:c', () => false), '이 방 전용 · a_b_c');
});

test('keys round-trip through the text field', () => {
    assert.equal(formatKeys(['균열', 'rift']), '균열, rift');
    assert.deepEqual(parseKeys('균열, rift ,'), ['균열', 'rift']);
    const regexKeys = ['/a,b/i', 'c'];
    assert.deepEqual(parseKeys(formatKeys(regexKeys)), regexKeys);
    assert.deepEqual(parseKeys('/half, open'), ['/half', 'open']);
    assert.deepEqual(parseKeys('a\nb'), ['a', 'b']);
    assert.equal(countOccurrences('two weeks ... two weeks', 'two weeks'), 2);
    assert.equal(entryKey('AU', 2), entryKey('AU', '2'));
});

test('chat toggles clone entries with the chosen ON/OFF', () => {
    const original = { world: 'AU', uid: 2, disable: true };
    const payload = { globalLore: [original, { world: 'AU', uid: 5, disable: false }], chatLore: [] };
    const keep = payload.globalLore;
    assert.equal(applyToggles(payload, { [entryKey('AU', 2)]: true, [entryKey('AU', 5)]: true }), 1);
    assert.equal(payload.globalLore, keep);
    assert.equal(payload.globalLore[0].disable, false);
    assert.equal(original.disable, true, 'cached entry untouched');
    assert.equal(applyToggles(payload, {}), 0);
});

test('AI details: entries named in the request first, then active ones, within budget', () => {
    const entries = [
        { world: 'AU', uid: 1, comment: '균열', key: ['rift'], content: 'a'.repeat(10) },
        { world: 'AU', uid: 2, comment: 'Towers', key: ['탑'], content: 'b'.repeat(10) },
        { world: 'AU', uid: 3, comment: 'Big', key: [], content: 'c'.repeat(100) },
    ];
    const picked = pickDetails(entries, { request: '탑 2층 클리어 반영해줘', activeKeys: new Set([entryKey('AU', 3), entryKey('AU', 1)]), budget: 50 });
    assert.deepEqual(picked.map(e => e.uid), [2, 1], 'named first, Big skipped for budget');
});

test('AI details: a request naming nothing falls back to ON constant entries only', () => {
    // "2층 클리어까지 남은 시간 계산해서 다시 입력해줘" names no title or key, and nothing was captured this session.
    const entries = [
        { world: 'AU', uid: 0, comment: '성좌 헌터물', key: [], constant: true, disable: true, content: 'world' },
        { world: 'AU', uid: 5, comment: '탑 내부', key: ['tower'], constant: false, disable: false, content: 'inside' },
        { world: 'AU', uid: 2, comment: '헌터물 기본 설정 보강', key: [], constant: true, disable: false, content: 'two weeks' },
    ];
    assert.deepEqual(pickDetails(entries, { request: '2층 클리어까지 남은 시간 계산해서 다시 입력해줘' }).map(e => e.uid), [2]);
    assert.deepEqual(pickDetails(entries, { request: '성좌 헌터물 고쳐줘' }).map(e => e.uid), [0], 'named entries replace the fallback');
    assert.deepEqual(pickDetails(entries, { request: 'x', targets: new Set([entryKey('AU', 5)]) }).map(e => e.uid), [5], 'picked targets only');
});

test('AI messages carry the list, details, chat and request', () => {
    const [system, user] = buildAiMessages({
        request: '균열 추가해줘',
        entries: [{ world: 'AU', uid: 2, comment: 'Towers', key: ['탑'], constant: true, disable: true }],
        details: [{ world: 'AU', uid: 2, comment: 'Towers', content: 'two weeks' }],
        chatLines: recentChatLines([{ name: 'User', mes: 'hi' }, { name: 'N', mes: 'x', is_system: true }, { name: 'Lena', mes: 'yo' }], 1),
    });
    assert.equal(system.role, 'system');
    assert.match(system.content, /"proposals"/);
    assert.match(user.content, /AU \| 2 \| Towers \| 탑 \| constant, off/);
    assert.match(user.content, /### \[AU #2\] Towers\ntwo weeks/);
    assert.match(user.content, /## RECENT CHAT \(oldest first\)\n\nLena: yo/);
    assert.match(user.content, /## REQUEST\n\n균열 추가해줘$/);
});

test('AI replies are parsed leniently and validated', () => {
    const reply = 'Sure!\n```json\n{"proposals":[{"action":"create","comment":"균열","keys":["균열","rift"],"content":"## Rifts","reason":"요청"},' +
        '{"action":"update","world":"AU","uid":2,"content":"9 days"},{"action":"delete","content":"x"},{"action":"create","content":"  "}]}\n```';
    const list = parseProposals(reply);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], { action: 'create', world: '', uid: null, comment: '균열', key: ['균열', 'rift'], constant: false, content: '## Rifts', edits: [], reason: '요청' });
    assert.equal(list[1].world, 'AU');
    assert.equal(list[1].uid, 2);
    assert.throws(() => parseProposals('no json here'), /JSON을 찾지/);
    assert.throws(() => parseProposals('{"proposals": [}'), /깨져/);
    assert.deepEqual(parseProposals('{"proposals":[]}'), []);
});

test('line diff marks removed and added lines', () => {
    assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc').map(x => x.type), ['same', 'del', 'add', 'same']);
    assert.deepEqual(lineDiff('', 'x').map(x => x.type), ['del', 'add']);
});

test('extra instructions are appended to the system prompt', () => {
    const [system] = buildAiMessages({ request: 'x', entries: [], details: [], extra: '  한국어로  ' });
    assert.match(system.content, /Additional instructions from the user[^\n]*\n한국어로$/);
    assert.doesNotMatch(buildAiMessages({ request: 'x', entries: [], details: [] })[0].content, /Additional/);
});

test('updates as find/replace edits', () => {
    const [p] = parseProposals('{"proposals":[{"action":"update","world":"AU","uid":2,"edits":[{"find":"two weeks","replace":"12 days"},{"find":"","replace":"x"}],"reason":"r"}]}');
    assert.equal(p.content, null);
    assert.deepEqual(p.edits, [{ find: 'two weeks', replace: '12 days' }]);
    assert.deepEqual(applyEdits('Around two weeks remain. roughly two weeks remaining.', p.edits),
        { content: 'Around 12 days remain. roughly 12 days remaining.', missing: [] });
    assert.deepEqual(applyEdits('abc', [{ find: 'zzz', replace: 'y' }]).missing, ['zzz']);
    assert.deepEqual(parseProposals('{"proposals":[{"action":"update","world":"AU","uid":2,"edits":[]}]}'), [], 'an update with nothing to do is dropped');
});
