import { describe, expect, it } from 'vitest';
import { addTab, initialWorkspace, setTabSessionId, setTabTitle, type MakeId, type WorkspaceState } from './tabs';
import {
    MAX_TABS,
    clearWorkspace,
    loadWorkspace,
    readWorkspace,
    serializeWorkspace,
    workspaceStorageKey,
    writeWorkspace,
    type StorageLike,
} from './storage';

function makeIds(): MakeId {
    let n = 0;
    return () => `id-${++n}`;
}

function shaped(state: WorkspaceState) {
    return state.tabs.map(tab => ({
        id: tab.id,
        seq: tab.seq,
        kind: tab.kind,
        sessionId: tab.sessionId,
        title: tab.title,
        historyId: tab.historyId,
        historyCommand: tab.historyCommand,
        returnToTabId: tab.returnToTabId,
    }));
}

describe('workspaceStorageKey', () => {
    it('matches the legacy key derived from the pathname', () => {
        expect(workspaceStorageKey('/')).toBe('ttyd.session:/');
        expect(workspaceStorageKey('/tty/')).toBe('ttyd.session:/tty');
        expect(workspaceStorageKey('/tty///')).toBe('ttyd.session:/tty');
    });
});

describe('loadWorkspace - empty and legacy values', () => {
    it.each([null, '', '   '])('creates one empty tab for %j', raw => {
        const state = loadWorkspace(raw, makeIds());

        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].sessionId).toBeUndefined();
        expect(state.activeId).toBe(state.tabs[0].id);
    });

    it('migrates a bare session id into one tab', () => {
        const state = loadWorkspace('a1b2c3', makeIds());

        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].sessionId).toBe('a1b2c3');
        expect(state.tabs[0].seq).toBe(1);
        expect(state.tabs[0].title).toBeUndefined();
        expect(state.activeId).toBe(state.tabs[0].id);
        expect(state.nextSeq).toBe(2);
    });

    it('migrates a JSON-quoted id and a numeric-looking id', () => {
        expect(loadWorkspace('"a1b2c3"', makeIds()).tabs[0].sessionId).toBe('a1b2c3');
        expect(loadWorkspace('123456', makeIds()).tabs[0].sessionId).toBe('123456');
    });

    it.each(['{bad', '{"foo":1}', '[1,2]', 'null', 'x'.repeat(200), 'has space'])(
        'falls back to a default tab for %j',
        raw => {
            const state = loadWorkspace(raw, makeIds());
            expect(state.tabs).toHaveLength(1);
            expect(state.tabs[0].sessionId).toBeUndefined();
        }
    );
});

describe('loadWorkspace - new format', () => {
    it('round-trips tabs, titles, session ids and activeId', () => {
        const makeId = makeIds();
        const first = initialWorkspace(makeId);
        const withTitle = setTabTitle(first, first.activeId, 'vim ~/notes');
        const withSession = setTabSessionId(withTitle, first.activeId, 'session-1');
        const state = addTab(withSession, makeId);

        const restored = loadWorkspace(serializeWorkspace(state), makeIds());

        expect(restored.activeId).toBe(state.activeId);
        expect(restored.nextSeq).toBe(3);
        expect(shaped(restored)).toEqual(shaped(state));
        expect(serializeWorkspace(restored)).toBe(serializeWorkspace(state));
    });

    it('drops runtime-only fields from the serialized value', () => {
        const state = initialWorkspace(makeIds());
        state.tabs[0].viewingHistoryId = 'hist-1';
        state.tabs[0].connectionError = 'refused';

        const raw = serializeWorkspace(state);

        expect(raw).not.toContain('viewingHistoryId');
        expect(raw).not.toContain('connectionError');
        expect(loadWorkspace(raw, makeIds()).tabs[0].viewingHistoryId).toBeUndefined();
    });

    it('falls back to the first tab when activeId is dangling', () => {
        const raw = JSON.stringify({
            tabs: [
                { id: 'a', seq: 1 },
                { id: 'b', seq: 2 },
            ],
            activeId: 'missing',
        });

        expect(loadWorkspace(raw, makeIds()).activeId).toBe('a');
    });

    it('creates a tab when the stored tab list is empty', () => {
        const state = loadWorkspace(JSON.stringify({ tabs: [], activeId: '' }), makeIds());

        expect(state.tabs).toHaveLength(1);
        expect(state.activeId).toBe(state.tabs[0].id);
    });

    it('treats tab objects without a kind as terminals (previous format)', () => {
        const raw = JSON.stringify({
            tabs: [
                { id: 'a', seq: 1, sessionId: 'live-1', title: 'bash' },
                { id: 'b', seq: 2 },
            ],
            activeId: 'a',
        });
        const state = loadWorkspace(raw, makeIds());

        expect(state.tabs.map(tab => tab.kind)).toEqual(['terminal', 'terminal']);
        expect(state.tabs[0].sessionId).toBe('live-1');
        expect(state.tabs[0].title).toBe('bash');
        expect(state.activeId).toBe('a');
    });

    it('keeps duplicate session ids so several tabs can observe one PTY', () => {
        const raw = JSON.stringify({
            tabs: [
                { id: 'a', seq: 1, kind: 'terminal', sessionId: 'same' },
                { id: 'b', seq: 2, kind: 'terminal', sessionId: 'same' },
            ],
            activeId: 'b',
        });
        const state = loadWorkspace(raw, makeIds());

        expect(state.tabs[0].sessionId).toBe('same');
        expect(state.tabs[1].sessionId).toBe('same');
    });

    it('round-trips a replay tab with its history and return target', () => {
        const makeId = makeIds();
        const first = initialWorkspace(makeId);
        const state = addTab(first, makeId, {
            history: { id: 'hist-1', command: 'bash -l', returnToTabId: first.activeId },
        });
        const raw = serializeWorkspace(state);

        expect(raw).toContain('"kind":"replay"');
        expect(raw).toContain('hist-1');
        const restored = loadWorkspace(raw, makeIds());
        expect(shaped(restored)).toEqual(shaped(state));
        expect(serializeWorkspace(restored)).toBe(raw);
    });

    it('degrades a replay tab without a usable history id', () => {
        const raw = JSON.stringify({
            tabs: [{ id: 'a', seq: 1, kind: 'replay', sessionId: 'leaked', title: 'old' }],
            activeId: 'a',
        });
        const tab = loadWorkspace(raw, makeIds()).tabs[0];

        expect(tab.kind).toBe('terminal');
        expect(tab.sessionId).toBeUndefined();
        expect(tab.title).toBeUndefined();
        expect(tab.historyId).toBeUndefined();
    });

    it('clears dangling and self-referencing return targets', () => {
        const raw = JSON.stringify({
            tabs: [
                { id: 'a', seq: 1, kind: 'terminal' },
                { id: 'b', seq: 2, kind: 'replay', historyId: 'h1', returnToTabId: 'missing' },
                { id: 'c', seq: 3, kind: 'replay', historyId: 'h2', returnToTabId: 'c' },
                { id: 'd', seq: 4, kind: 'replay', historyId: 'h3', returnToTabId: 'a' },
            ],
            activeId: 'a',
        });
        const state = loadWorkspace(raw, makeIds());

        expect(state.tabs[1].returnToTabId).toBeUndefined();
        expect(state.tabs[2].returnToTabId).toBeUndefined();
        expect(state.tabs[3].returnToTabId).toBe('a');
    });

    it('repairs duplicate or invalid tab ids', () => {
        const raw = JSON.stringify({
            tabs: [{ id: 'x', seq: 1 }, { id: 'x', seq: 2 }, { id: '', seq: 3 }, { seq: 4 }, null],
            activeId: 'x',
        });
        const state = loadWorkspace(raw, makeIds());
        const ids = state.tabs.map(tab => tab.id);

        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5);
        expect(ids.every(id => id.length > 0)).toBe(true);
    });

    it('normalizes titles, sequence numbers and session ids', () => {
        const raw = JSON.stringify({
            tabs: [
                { id: 'a', seq: 0, title: '  ' },
                { id: 'b', seq: -3, title: '  htop  ', sessionId: 'y'.repeat(200) },
                { id: 'c', title: 'z'.repeat(200), sessionId: 'ok' },
            ],
            activeId: 'a',
        });
        const state = loadWorkspace(raw, makeIds());

        expect(state.tabs[0].seq).toBe(1);
        expect(state.tabs[0].title).toBeUndefined();
        expect(state.tabs[1].seq).toBe(2);
        expect(state.tabs[1].title).toBe('htop');
        expect(state.tabs[1].sessionId).toBeUndefined();
        expect(state.tabs[2].title).toHaveLength(128);
        expect(state.tabs[2].sessionId).toBe('ok');
        expect(state.nextSeq).toBe(4);
    });

    it('caps the number of restored tabs', () => {
        const tabs = Array.from({ length: MAX_TABS + 5 }, (_, index) => ({ id: `t${index}`, seq: index + 1 }));
        const state = loadWorkspace(JSON.stringify({ tabs, activeId: 't0' }), makeIds());

        expect(state.tabs).toHaveLength(MAX_TABS);
    });
});

describe('storage wrappers', () => {
    it('reads and writes through the provided storage', () => {
        const values = new Map<string, string>();
        const storage: StorageLike = {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => void values.set(key, value),
            removeItem: key => void values.delete(key),
        };
        const key = workspaceStorageKey('/tty');
        const state = initialWorkspace(makeIds());

        expect(readWorkspace(storage, key, makeIds()).tabs).toHaveLength(1);
        expect(writeWorkspace(storage, key, state)).toBe(true);
        expect(values.get(key)).toBe(serializeWorkspace(state));
        expect(readWorkspace(storage, key, makeIds()).tabs[0].id).toBe(state.tabs[0].id);
        clearWorkspace(storage, key);
        expect(values.has(key)).toBe(false);
    });

    it('degrades gracefully when storage throws', () => {
        const storage: StorageLike = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
            removeItem: () => {
                throw new Error('blocked');
            },
        };

        expect(() => readWorkspace(storage, 'key', makeIds())).not.toThrow();
        expect(readWorkspace(storage, 'key', makeIds()).tabs).toHaveLength(1);
        expect(writeWorkspace(storage, 'key', initialWorkspace(makeIds()))).toBe(false);
        expect(() => clearWorkspace(storage, 'key')).not.toThrow();
    });
});
