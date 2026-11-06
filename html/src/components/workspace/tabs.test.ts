import { describe, expect, it } from 'vitest';
import {
    activateTab,
    addTab,
    attachedSessionIds,
    closeTab,
    derivedNextSeq,
    initialWorkspace,
    replayHistoryIds,
    resolveTabTitle,
    sessionHolders,
    setTabConnectionError,
    setTabSessionId,
    setTabTitle,
    setTabViewingHistory,
    type MakeId,
    type WorkspaceState,
} from './tabs';

function makeIds(): MakeId {
    let n = 0;
    return () => `id-${++n}`;
}

function frozen(state: WorkspaceState): WorkspaceState {
    Object.freeze(state.tabs);
    for (const tab of state.tabs) Object.freeze(tab);
    return Object.freeze(state);
}

describe('initialWorkspace', () => {
    it('starts with one empty terminal', () => {
        const state = initialWorkspace(makeIds());

        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].sessionId).toBeUndefined();
        expect(state.tabs[0].title).toBeUndefined();
        expect(state.activeId).toBe(state.tabs[0].id);
        expect(state.nextSeq).toBe(2);
        expect(resolveTabTitle(state.tabs[0])).toBe('Terminal 1');
    });
});

describe('addTab / derivedNextSeq', () => {
    it('adds a fresh tab without a session id and activates it', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId);

        expect(state.tabs).toHaveLength(2);
        expect(state.tabs[1].sessionId).toBeUndefined();
        expect(state.tabs[1].seq).toBe(2);
        expect(state.activeId).toBe(state.tabs[1].id);
        expect(state.nextSeq).toBe(3);
        expect(resolveTabTitle(state.tabs[1])).toBe('Terminal 2');
    });

    it('derives the next sequence from the highest existing one', () => {
        expect(derivedNextSeq([])).toBe(1);
        expect(
            derivedNextSeq([
                { id: 'a', seq: 3, kind: 'terminal' },
                { id: 'b', seq: 7, kind: 'replay' },
            ])
        ).toBe(8);
    });

    it('does not mutate the input state', () => {
        const makeId = makeIds();
        const state = frozen(initialWorkspace(makeId));

        expect(() => addTab(state, makeId)).not.toThrow();
        expect(state.tabs).toHaveLength(1);
    });
});

describe('closeTab', () => {
    it('activates the right neighbour when the active tab is closed', () => {
        const makeId = makeIds();
        const state = activateTab(addTab(addTab(initialWorkspace(makeId), makeId), makeId), 'id-1');
        const next = closeTab(state, state.tabs[0].id, makeId);

        expect(next.tabs.map(tab => tab.id)).toEqual([state.tabs[1].id, state.tabs[2].id]);
        expect(next.activeId).toBe(state.tabs[1].id);
    });

    it('activates the left neighbour when the last tab is closed', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId);
        const activated = activateTab(state, state.tabs[1].id);
        const next = closeTab(activated, state.tabs[1].id, makeId);

        expect(next.tabs).toHaveLength(1);
        expect(next.activeId).toBe(state.tabs[0].id);
    });

    it('keeps activeId when a background tab is closed', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId);
        const next = closeTab(state, state.tabs[0].id, makeId);

        expect(next.activeId).toBe(state.tabs[1].id);
    });

    it('replaces the last tab with a fresh empty one and keeps numbering', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId);
        const last = closeTab(state, state.tabs[0].id, makeId);
        const next = closeTab(last, last.activeId, makeId);

        expect(next.tabs).toHaveLength(1);
        expect(next.tabs[0].sessionId).toBeUndefined();
        expect(next.tabs[0].seq).toBe(3);
        expect(next.activeId).toBe(next.tabs[0].id);
        expect(next.nextSeq).toBe(4);
    });

    it('ignores unknown ids', () => {
        const makeId = makeIds();
        const state = initialWorkspace(makeId);

        expect(closeTab(state, 'missing', makeId)).toBe(state);
    });
});

describe('tab kinds', () => {
    it('starts with a terminal tab', () => {
        const state = initialWorkspace(makeIds());
        expect(state.tabs[0].kind).toBe('terminal');
        expect(resolveTabTitle(state.tabs[0])).toBe('Terminal 1');
    });

    it('creates a terminal tab with a preset session and title', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId, { sessionId: 'live-1', title: '  bash  ' });

        expect(state.tabs[1].kind).toBe('terminal');
        expect(state.tabs[1].sessionId).toBe('live-1');
        expect(resolveTabTitle(state.tabs[1])).toBe('bash');
        expect(sessionHolders(state, 'live-1')).toEqual([state.tabs[1].id]);
    });

    it('creates a replay tab that never owns a live session', () => {
        const makeId = makeIds();
        const first = initialWorkspace(makeId);
        const state = addTab(first, makeId, {
            history: { id: 'hist-1', command: 'bash -l', returnToTabId: first.activeId },
        });
        const tab = state.tabs[1];

        expect(tab.kind).toBe('replay');
        expect(tab.sessionId).toBeUndefined();
        expect(tab.historyId).toBe('hist-1');
        expect(tab.historyCommand).toBe('bash -l');
        expect(tab.returnToTabId).toBe(first.activeId);
        expect(resolveTabTitle(tab)).toBe('bash -l (history)');
        expect(replayHistoryIds(state)).toEqual(['hist-1']);
        expect(sessionHolders(state, 'hist-1')).toEqual([]);
    });

    it('falls back to the history command when a replay title is cleared', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId, {
            history: { id: 'hist-1', command: 'htop' },
        });
        const cleared = setTabTitle(state, state.activeId, undefined);

        expect(resolveTabTitle(cleared.tabs[1])).toBe('htop');
    });

    it('lists every holder of a shared session and every replayed history', () => {
        const makeId = makeIds();
        let state = addTab(initialWorkspace(makeId), makeId, { sessionId: 'shared' });
        state = addTab(state, makeId, { sessionId: 'shared' });
        state = addTab(state, makeId, { history: { id: 'h1', command: 'a' } });
        state = addTab(state, makeId, { history: { id: 'h2', command: 'b' } });

        expect(sessionHolders(state, 'shared')).toHaveLength(2);
        expect(attachedSessionIds(state)).toEqual(['shared']);
        expect(replayHistoryIds(state)).toEqual(['h1', 'h2']);
    });

    it('keeps the new reducers immutable', () => {
        const makeId = makeIds();
        const state = frozen(initialWorkspace(makeId));

        expect(() => addTab(state, makeId, { history: { id: 'h1', command: 'x' } })).not.toThrow();
        expect(() => closeTab(state, state.activeId, makeId)).not.toThrow();
        expect(state.tabs[0].kind).toBe('terminal');
    });
});

describe('closeTab with replay tabs', () => {
    it('activates the source tab when an active replay is ended', () => {
        const makeId = makeIds();
        const first = initialWorkspace(makeId);
        const withReplay = addTab(first, makeId, {
            history: { id: 'h1', command: 'x', returnToTabId: first.activeId },
        });
        const next = closeTab(withReplay, withReplay.activeId, makeId);

        expect(next.tabs).toHaveLength(1);
        expect(next.activeId).toBe(first.activeId);
    });

    it('ignores a dangling returnToTabId', () => {
        const makeId = makeIds();
        let state = addTab(initialWorkspace(makeId), makeId);
        state = addTab(state, makeId, {
            history: { id: 'h1', command: 'x', returnToTabId: 'missing' },
        });
        const next = closeTab(state, state.activeId, makeId);

        expect(next.tabs).toHaveLength(2);
        expect(next.activeId).toBe(state.tabs[1].id);
    });

    it('does not steal focus when a background replay is closed', () => {
        const makeId = makeIds();
        const first = initialWorkspace(makeId);
        const withReplay = addTab(first, makeId, {
            history: { id: 'h1', command: 'x', returnToTabId: first.activeId },
        });
        const state = activateTab(withReplay, first.activeId);
        const next = closeTab(state, withReplay.tabs[1].id, makeId);

        expect(next.activeId).toBe(first.activeId);
    });
});

describe('tab setters', () => {
    it('activates only existing tabs', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId);
        const next = activateTab(state, state.tabs[0].id);

        expect(next.activeId).toBe(state.tabs[0].id);
        expect(activateTab(state, 'missing')).toBe(state);
    });

    it('normalizes titles and falls back to the default name', () => {
        const makeId = makeIds();
        const state = initialWorkspace(makeId);
        const id = state.activeId;
        const named = setTabTitle(state, id, '  vim ~/notes  ');

        expect(named.tabs[0].title).toBe('vim ~/notes');
        expect(resolveTabTitle(named.tabs[0])).toBe('vim ~/notes');
        expect(setTabTitle(named, id, '   ').tabs[0].title).toBeUndefined();
        expect(resolveTabTitle(setTabTitle(named, id, '').tabs[0])).toBe('Terminal 1');
        expect(setTabTitle(named, id, 'vim ~/notes')).toBe(named);
        expect(setTabTitle(named, id, 'x'.repeat(200)).tabs[0].title).toHaveLength(128);
    });

    it('tracks session ids, history ids and connection errors', () => {
        const makeId = makeIds();
        const state = initialWorkspace(makeId);
        const id = state.activeId;
        const withSession = setTabSessionId(state, id, 'abc');

        expect(withSession.tabs[0].sessionId).toBe('abc');
        expect(setTabSessionId(withSession, id, 'abc')).toBe(withSession);
        expect(setTabSessionId(withSession, id, undefined).tabs[0].sessionId).toBeUndefined();
        expect(setTabViewingHistory(state, id, 'hist-1').tabs[0].viewingHistoryId).toBe('hist-1');
        expect(setTabConnectionError(state, id, 'refused').tabs[0].connectionError).toBe('refused');
    });

    it('deduplicates attached session ids', () => {
        const makeId = makeIds();
        const state = addTab(initialWorkspace(makeId), makeId);
        const withSessions = setTabSessionId(
            setTabSessionId(state, state.tabs[0].id, 'same'),
            state.tabs[1].id,
            'same'
        );

        expect(attachedSessionIds(withSessions)).toEqual(['same']);
        expect(attachedSessionIds(state)).toEqual([]);
    });
});
