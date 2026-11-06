import {
    derivedNextSeq,
    initialWorkspace,
    normalizeTabTitle,
    type MakeId,
    type TabState,
    type WorkspaceState,
} from './tabs';

export const MAX_TABS = 32;
export const MAX_ID_LENGTH = 128;

export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Keep the legacy key so a stored plain session id can still be migrated. */
export function workspaceStorageKey(pathname: string): string {
    return `ttyd.session:${pathname.replace(/[/]+$/, '') || '/'}`;
}

function isId(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID_LENGTH) return false;
    for (const char of value) {
        const code = char.charCodeAt(0);
        if (code <= 0x20 || code === 0x7f) return false;
    }
    return true;
}

function fromLegacyId(raw: string, makeId: MakeId): WorkspaceState {
    if (!isId(raw) || raw.startsWith('{') || raw.startsWith('[')) {
        return initialWorkspace(makeId);
    }
    const state = initialWorkspace(makeId);
    return { ...state, tabs: [{ ...state.tabs[0], sessionId: raw }] };
}

function validateTab(raw: unknown, index: number, seen: Set<string>, makeId: MakeId): TabState {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    let id = typeof source.id === 'string' ? source.id.trim() : '';
    if (!isId(id) || seen.has(id)) {
        id = makeId();
        while (seen.has(id)) id = makeId();
    }
    seen.add(id);

    const seq =
        typeof source.seq === 'number' && Number.isInteger(source.seq) && source.seq >= 1 ? source.seq : index + 1;
    const title = normalizeTabTitle(typeof source.title === 'string' ? source.title : undefined);

    // Tabs written before the replay model had no `kind`; they are terminals.
    if (source.kind === 'replay') {
        const historyId = isId(source.historyId) ? source.historyId : undefined;
        if (!historyId) {
            // A replay without a usable history id degrades to an empty terminal.
            return { id, seq, kind: 'terminal', sessionId: undefined, title: undefined };
        }
        return {
            id,
            seq,
            kind: 'replay',
            historyId,
            historyCommand: normalizeTabTitle(
                typeof source.historyCommand === 'string' ? source.historyCommand : undefined
            ),
            returnToTabId: isId(source.returnToTabId) ? source.returnToTabId : undefined,
            title,
        };
    }

    return {
        id,
        seq,
        kind: 'terminal',
        sessionId: isId(source.sessionId) ? source.sessionId : undefined,
        title,
    };
}

function fromObject(value: Record<string, unknown>, makeId: MakeId): WorkspaceState {
    const rawTabs = (Array.isArray(value.tabs) ? value.tabs : []).slice(0, MAX_TABS) as unknown[];
    const seen = new Set<string>();
    let tabs = rawTabs.map((raw, index) => validateTab(raw, index, seen, makeId));

    if (tabs.length === 0) {
        return initialWorkspace(makeId);
    }

    const activeId =
        typeof value.activeId === 'string' && tabs.some(tab => tab.id === value.activeId) ? value.activeId : tabs[0].id;

    // A source tab can disappear independently of the replay that points to it.
    const ids = new Set(tabs.map(tab => tab.id));
    tabs = tabs.map(tab =>
        tab.returnToTabId && (!ids.has(tab.returnToTabId) || tab.returnToTabId === tab.id)
            ? { ...tab, returnToTabId: undefined }
            : tab
    );

    // Multiple tabs may legitimately observe the same live PTY: the server
    // counts attachments. Never clear duplicate session ids here, otherwise a
    // reload would break those tabs and make the close/DELETE check misjudge
    // whether a session is still in use.
    return { tabs, activeId, nextSeq: derivedNextSeq(tabs) };
}

/**
 * Parse the stored value. The legacy format was a bare session id; the new
 * format is `{ tabs, activeId }`. Anything malformed degrades to one empty tab.
 */
export function loadWorkspace(raw: string | null, makeId: MakeId): WorkspaceState {
    if (raw === null || raw.trim() === '') return initialWorkspace(makeId);

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = raw;
    }
    // A bare `null` / boolean is a corrupt value, not a legacy session id.
    if (parsed === null || typeof parsed === 'boolean') return initialWorkspace(makeId);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        if (Array.isArray(candidate.tabs)) {
            return fromObject(candidate, makeId);
        }
    }
    // A numeric-looking legacy id parses as a number, so fall back to the raw text.
    return fromLegacyId(typeof parsed === 'string' ? parsed : raw, makeId);
}

/** Only persisted fields are written; runtime markers never enter sessionStorage. */
export function serializeWorkspace(state: WorkspaceState): string {
    return JSON.stringify({
        tabs: state.tabs.map(tab =>
            tab.kind === 'replay'
                ? {
                      id: tab.id,
                      seq: tab.seq,
                      kind: 'replay',
                      historyId: tab.historyId,
                      historyCommand: tab.historyCommand,
                      returnToTabId: tab.returnToTabId,
                      title: tab.title,
                  }
                : {
                      id: tab.id,
                      seq: tab.seq,
                      kind: 'terminal',
                      sessionId: tab.sessionId,
                      title: tab.title,
                  }
        ),
        activeId: state.activeId,
    });
}

export function readWorkspace(storage: StorageLike, key: string, makeId: MakeId): WorkspaceState {
    try {
        return loadWorkspace(storage.getItem(key), makeId);
    } catch {
        // sessionStorage can be unavailable in private or restricted contexts.
        return initialWorkspace(makeId);
    }
}

export function writeWorkspace(storage: StorageLike, key: string, state: WorkspaceState): boolean {
    try {
        storage.setItem(key, serializeWorkspace(state));
        return true;
    } catch {
        return false;
    }
}

export function clearWorkspace(storage: StorageLike, key: string): void {
    try {
        storage.removeItem(key);
    } catch {
        // Ignore unavailable storage.
    }
}
