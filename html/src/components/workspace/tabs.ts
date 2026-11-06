export type TabKind = 'terminal' | 'replay';

export interface PersistedTab {
    id: string;
    seq: number;
    kind: TabKind;
    /** Live PTY session id, terminal tabs only. */
    sessionId?: string;
    title?: string;
    /** History record id for the attachOnly handshake, replay tabs only. */
    historyId?: string;
    /** Original command, used as a fallback label and for document.title. */
    historyCommand?: string;
    /** Tab to activate when the replay is ended. */
    returnToTabId?: string;
}

/** A tab plus runtime-only state that must never be written to sessionStorage. */
export interface TabState extends PersistedTab {
    viewingHistoryId?: string;
    connectionError?: string;
}

export interface WorkspaceState {
    tabs: TabState[];
    activeId: string;
    nextSeq: number;
}

/** Initial data for a new tab; `history` and `sessionId` are mutually exclusive. */
export interface NewTabInit {
    sessionId?: string;
    title?: string;
    history?: {
        id: string;
        command: string;
        returnToTabId?: string;
    };
}

export type MakeId = () => string;

export const MAX_TITLE_LENGTH = 128;

let fallbackCounter = 0;

/** Stable tab ids; `makeId` is injectable so the reducers can be tested. */
export function defaultMakeId(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // crypto can be unavailable on insecure origins.
    }
    fallbackCounter += 1;
    return `tab-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

export function createEmptyTab(makeId: MakeId, seq: number): TabState {
    return { id: makeId(), seq, kind: 'terminal' };
}

export function initialWorkspace(makeId: MakeId): WorkspaceState {
    const tab = createEmptyTab(makeId, 1);
    return { tabs: [tab], activeId: tab.id, nextSeq: 2 };
}

export function derivedNextSeq(tabs: readonly PersistedTab[]): number {
    return tabs.reduce((max, tab) => Math.max(max, tab.seq), 0) + 1;
}

export function resolveTabTitle(tab: PersistedTab): string {
    if (tab.kind === 'replay') {
        return tab.title ?? tab.historyCommand ?? `Replay ${tab.seq}`;
    }
    return tab.title ?? `Terminal ${tab.seq}`;
}

/** Trim and clamp a shell title; an empty value falls back to the default name. */
export function normalizeTabTitle(title: string | undefined): string | undefined {
    if (typeof title !== 'string') return undefined;
    const value = title.trim().slice(0, MAX_TITLE_LENGTH);
    return value === '' ? undefined : value;
}

function updateTab(state: WorkspaceState, id: string, update: (tab: TabState) => TabState): WorkspaceState {
    let changed = false;
    const tabs = state.tabs.map(tab => {
        if (tab.id !== id) return tab;
        const next = update(tab);
        if (next !== tab) changed = true;
        return next;
    });
    return changed ? { ...state, tabs } : state;
}

/**
 * Add a tab. With `init.history` the tab is a read-only replay and never owns
 * a live session id; otherwise it is a regular terminal tab.
 */
export function addTab(state: WorkspaceState, makeId: MakeId, init?: NewTabInit): WorkspaceState {
    const base = createEmptyTab(makeId, state.nextSeq);
    let tab: TabState;

    if (init?.history) {
        const command = normalizeTabTitle(init.history.command) ?? init.history.id;
        tab = {
            ...base,
            kind: 'replay',
            historyId: init.history.id,
            historyCommand: command,
            returnToTabId: init.history.returnToTabId,
            title: normalizeTabTitle(`${command} (history)`),
        };
    } else {
        tab = {
            ...base,
            kind: 'terminal',
            sessionId: init?.sessionId,
            title: normalizeTabTitle(init?.title),
        };
    }

    return { tabs: [...state.tabs, tab], activeId: tab.id, nextSeq: state.nextSeq + 1 };
}

/**
 * Close a tab. Closing the last one immediately replaces it with a fresh tab
 * (no session id), so the page always has a terminal to interact with.
 * An active replay tab returns to the tab it was opened from.
 */
export function closeTab(state: WorkspaceState, id: string, makeId: MakeId): WorkspaceState {
    const index = state.tabs.findIndex(tab => tab.id === id);
    if (index < 0) return state;

    if (state.tabs.length === 1) {
        const tab = createEmptyTab(makeId, state.nextSeq);
        return { tabs: [tab], activeId: tab.id, nextSeq: state.nextSeq + 1 };
    }

    const closing = state.tabs[index];
    const tabs = state.tabs.filter(tab => tab.id !== id);
    let activeId = state.activeId;
    if (activeId === id) {
        // Only an active replay tab may steer focus back to its source tab;
        // closing a background replay must not steal the active tab.
        const preferred =
            closing.kind === 'replay' && closing.returnToTabId
                ? tabs.find(tab => tab.id === closing.returnToTabId)?.id
                : undefined;
        // Prefer the right neighbour; the clamp picks the left one at the end.
        activeId = preferred ?? tabs[Math.min(index, tabs.length - 1)].id;
    }
    return { ...state, tabs, activeId };
}

export function activateTab(state: WorkspaceState, id: string): WorkspaceState {
    if (state.activeId === id || !state.tabs.some(tab => tab.id === id)) return state;
    return { ...state, activeId: id };
}

export function setTabTitle(state: WorkspaceState, id: string, title: string | undefined): WorkspaceState {
    const value = normalizeTabTitle(title);
    return updateTab(state, id, tab => (tab.title === value ? tab : { ...tab, title: value }));
}

export function setTabSessionId(state: WorkspaceState, id: string, sessionId: string | undefined): WorkspaceState {
    return updateTab(state, id, tab => (tab.sessionId === sessionId ? tab : { ...tab, sessionId }));
}

export function setTabViewingHistory(state: WorkspaceState, id: string, historyId: string | undefined): WorkspaceState {
    return updateTab(state, id, tab =>
        tab.viewingHistoryId === historyId ? tab : { ...tab, viewingHistoryId: historyId }
    );
}

export function setTabConnectionError(state: WorkspaceState, id: string, error: string | undefined): WorkspaceState {
    return updateTab(state, id, tab => (tab.connectionError === error ? tab : { ...tab, connectionError: error }));
}

/** All live session ids currently owned by this page, deduplicated. */
export function attachedSessionIds(state: WorkspaceState): string[] {
    const ids = new Set<string>();
    for (const tab of state.tabs) {
        if (tab.sessionId) ids.add(tab.sessionId);
    }
    return [...ids];
}

/** Every terminal tab holding a live session id (not deduplicated). */
export function sessionHolders(state: WorkspaceState, sessionId: string): string[] {
    return state.tabs.filter(tab => tab.kind === 'terminal' && tab.sessionId === sessionId).map(tab => tab.id);
}

/** Every history id currently replayed by a tab on this page. */
export function replayHistoryIds(state: WorkspaceState): string[] {
    const ids = new Set<string>();
    for (const tab of state.tabs) {
        if (tab.kind === 'replay' && tab.historyId) ids.add(tab.historyId);
    }
    return [...ids];
}
