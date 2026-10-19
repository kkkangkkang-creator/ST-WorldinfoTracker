import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
    keyMatches, scanMessages, explainEntry, recursionText, applyReplacements,
    freeUid, buildCopy, chatBookName, formatKeys, parseKeys, countOccurrences, entryKey,
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
