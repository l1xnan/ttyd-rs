import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIENT_OPTIONS } from '../terminal/xterm';
import { Workspace, type WorkspaceProps } from './index';
import { workspaceStorageKey } from './storage';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function response(status: number, body?: unknown): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    } as Response;
}

const sessionsPayload = {
    sessions: [
        { id: 'live-1', owner: 'alice', command: 'bash', state: 'running', attached: 1 },
        { id: 'live-2', owner: 'alice', command: 'htop', state: 'running', attached: 0 },
    ],
    history: [
        { id: 'history-1', owner: 'alice', command: 'bash -l', state: 'exited', exitCode: 0 },
        { id: 'history-2', owner: 'alice', command: 'htop', state: 'exited', exitCode: 1 },
    ],
};

const props: WorkspaceProps = {
    wsUrl: 'ws://localhost/ws',
    tokenUrl: 'http://localhost/token',
    sessionsUrl: 'http://localhost/sessions',
    clientOptions: { ...DEFAULT_CLIENT_OPTIONS },
    termOptions: {},
    flowControl: { limit: 100000, highWater: 10, lowWater: 4 },
    sessionTimeout: 30,
    loginEnabled: false,
    loggingOut: false,
    error: '',
    onAuthRequired: () => {},
    onLogout: () => {},
};

interface StoredTab {
    id: string;
    seq: number;
    kind: 'terminal' | 'replay';
    sessionId?: string;
    title?: string;
    historyId?: string;
    historyCommand?: string;
    returnToTabId?: string;
}

describe('Workspace × session panel', () => {
    let container: HTMLElement;
    let key: string;
    let deleteRequests: string[];
    let deleteMode: 'ok' | 'forbidden' | 'throw';

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        key = workspaceStorageKey(window.location.pathname);
        window.sessionStorage.clear();
        deleteRequests = [];
        deleteMode = 'ok';

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL, init?: RequestInit) => {
                if (init?.method === 'DELETE') {
                    deleteRequests.push(String(input));
                    if (deleteMode === 'throw') throw new Error('network down');
                    return response(deleteMode === 'forbidden' ? 403 : 204);
                }
                const url = String(input);
                if (url.includes('/sessions')) return response(200, sessionsPayload);
                if (url.includes('/token')) return response(401);
                return response(404);
            })
        );
    });

    afterEach(() => {
        render(null, container);
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function mount() {
        render(h(Workspace, props), container);
        return flush();
    }

    function seed(tabs: StoredTab[], activeId: string) {
        window.sessionStorage.setItem(key, JSON.stringify({ tabs, activeId }));
    }

    function stored(): { tabs: StoredTab[]; activeId: string } {
        return JSON.parse(window.sessionStorage.getItem(key) ?? '{}') as {
            tabs: StoredTab[];
            activeId: string;
        };
    }

    function tabs() {
        return container.querySelectorAll('.workspace-tab');
    }

    async function openDrawer() {
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();
    }

    function rows() {
        return container.querySelectorAll('.session-row');
    }

    function closeTab(index: number) {
        (tabs()[index].querySelector('.workspace-tab-close') as HTMLButtonElement).click();
        return flush();
    }

    it('attach opens a new terminal tab instead of replacing the active one', async () => {
        await mount();
        const original = stored().activeId;
        await openDrawer();
        (rows()[0] as HTMLButtonElement).click();
        await flush();

        const state = stored();
        expect(state.tabs).toHaveLength(2);
        expect(state.tabs[0].id).toBe(original);
        expect(state.tabs[0].sessionId).toBeUndefined();
        expect(state.tabs[1].kind).toBe('terminal');
        expect(state.tabs[1].sessionId).toBe('live-1');
        expect(state.tabs[1].title).toBe('bash');
        expect(state.activeId).toBe(state.tabs[1].id);
        expect(container.querySelector('.session-drawer')).toBeNull();
    });

    it('replay opens a new read-only tab that points back to its source', async () => {
        await mount();
        const source = stored().activeId;
        await openDrawer();
        // Two running rows come first, so index 2 is the first history row.
        (rows()[2] as HTMLButtonElement).click();
        await flush();

        const state = stored();
        expect(state.tabs).toHaveLength(2);
        expect(state.tabs[0].id).toBe(source);
        expect(state.tabs[1].kind).toBe('replay');
        expect(state.tabs[1].historyId).toBe('history-1');
        expect(state.tabs[1].sessionId).toBeUndefined();
        expect(state.tabs[1].returnToTabId).toBe(source);
        expect(state.tabs[1].title).toBe('bash -l (history)');
        expect(state.activeId).toBe(state.tabs[1].id);
        expect(tabs()[1].textContent).toContain('bash -l');
        expect(container.querySelector('.workspace-end-replay')).not.toBeNull();
    });

    it('New tab in the panel is the same action as the tab bar + button', async () => {
        await mount();
        await openDrawer();

        expect(container.querySelector('.session-new')?.textContent).toBe('New tab');
        (container.querySelector('.session-new') as HTMLButtonElement).click();
        await flush();
        expect(stored().tabs).toHaveLength(2);
        expect(stored().tabs[1].kind).toBe('terminal');
        expect(stored().tabs[1].sessionId).toBeUndefined();

        (container.querySelector('.workspace-add') as HTMLButtonElement).click();
        await flush();
        expect(stored().tabs).toHaveLength(3);
        expect(stored().tabs[2].kind).toBe('terminal');
        expect(stored().tabs[2].sessionId).toBeUndefined();
    });

    it('End replay closes the replay tab and activates the source tab', async () => {
        await mount();
        const source = stored().activeId;
        await openDrawer();
        (rows()[2] as HTMLButtonElement).click();
        await flush();
        expect(stored().tabs).toHaveLength(2);

        (container.querySelector('.workspace-end-replay') as HTMLButtonElement).click();
        await flush();

        expect(stored().tabs).toHaveLength(1);
        expect(stored().activeId).toBe(source);
        expect(deleteRequests).toHaveLength(0);
        expect(container.querySelector('.workspace-end-replay')).toBeNull();
    });

    it('DELETE is sent only when no other tab on this page holds the session', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal', sessionId: 'shared' },
                { id: 'b', seq: 2, kind: 'terminal', sessionId: 'shared' },
            ],
            'a'
        );
        await mount();

        await closeTab(0);
        expect(deleteRequests).toHaveLength(0);
        expect(stored().tabs).toHaveLength(1);
        expect(stored().tabs[0].sessionId).toBe('shared');

        await closeTab(0);
        expect(deleteRequests).toEqual(['http://localhost/sessions/shared']);
        expect(stored().tabs).toHaveLength(1);
        expect(stored().tabs[0].sessionId).toBeUndefined();
    });

    it('closing a replay tab never sends a DELETE', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal', sessionId: 'live-9' },
                {
                    id: 'b',
                    seq: 2,
                    kind: 'replay',
                    historyId: 'history-1',
                    historyCommand: 'bash -l',
                    returnToTabId: 'a',
                    title: 'bash -l (history)',
                },
            ],
            'b'
        );
        await mount();

        await closeTab(1);
        expect(deleteRequests).toHaveLength(0);
        expect(stored().activeId).toBe('a');
        expect(stored().tabs).toHaveLength(1);
    });

    it('end-and-archive on a running session closes every tab holding it', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal', sessionId: 'live-1' },
                { id: 'b', seq: 2, kind: 'terminal', sessionId: 'live-1' },
                { id: 'c', seq: 3, kind: 'terminal' },
            ],
            'a'
        );
        await mount();
        await openDrawer();

        const ends = container.querySelectorAll('.session-end');
        expect(ends).toHaveLength(2);
        (ends[0] as HTMLButtonElement).click();
        await flush();

        expect(deleteRequests).toEqual(['http://localhost/sessions/live-1']);
        expect(stored().tabs).toHaveLength(1);
        expect(stored().tabs[0].id).toBe('c');
        expect(tabs()).toHaveLength(1);
    });

    it('deleting a history record closes every replay tab for it', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal' },
                { id: 'b', seq: 2, kind: 'replay', historyId: 'history-1', historyCommand: 'bash -l' },
                { id: 'c', seq: 3, kind: 'replay', historyId: 'history-1', historyCommand: 'bash -l' },
            ],
            'a'
        );
        await mount();
        await openDrawer();

        (container.querySelector('.session-delete') as HTMLButtonElement).click();
        await flush();

        expect(deleteRequests).toEqual(['http://localhost/sessions/history-1']);
        expect(stored().tabs).toHaveLength(1);
        expect(stored().tabs[0].id).toBe('a');
    });

    it('highlights history rows for every replay tab, not only the active one', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal' },
                { id: 'b', seq: 2, kind: 'replay', historyId: 'history-1', historyCommand: 'bash -l' },
                { id: 'c', seq: 3, kind: 'replay', historyId: 'history-2', historyCommand: 'htop' },
            ],
            'a'
        );
        await mount();
        await openDrawer();

        expect(container.querySelectorAll('.session-row--active')).toHaveLength(2);
    });

    it('clicking a session already open in a tab activates that tab', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal' },
                { id: 'b', seq: 2, kind: 'terminal', sessionId: 'live-1' },
            ],
            'a'
        );
        await mount();
        await openDrawer();

        (rows()[0] as HTMLButtonElement).click();
        await flush();

        expect(stored().tabs).toHaveLength(2);
        expect(stored().activeId).toBe('b');
        expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
        expect(deleteRequests).toHaveLength(0);
        expect(container.querySelector('.session-drawer')).toBeNull();
    });

    it('clicking a history record already replayed activates that replay tab', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal' },
                {
                    id: 'b',
                    seq: 2,
                    kind: 'replay',
                    historyId: 'history-1',
                    historyCommand: 'bash -l',
                    returnToTabId: 'a',
                },
            ],
            'a'
        );
        await mount();
        await openDrawer();

        (rows()[2] as HTMLButtonElement).click();
        await flush();

        expect(stored().tabs).toHaveLength(2);
        expect(stored().activeId).toBe('b');
        expect(stored().tabs[1].kind).toBe('replay');
        expect(container.querySelector('.workspace-end-replay')).not.toBeNull();
    });

    it('modifier-click still opens a duplicate tab', async () => {
        seed([{ id: 'a', seq: 1, kind: 'terminal', sessionId: 'live-1' }], 'a');
        await mount();
        await openDrawer();

        rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
        await flush();

        expect(stored().tabs).toHaveLength(2);
        expect(stored().tabs[1].kind).toBe('terminal');
        expect(stored().tabs[1].sessionId).toBe('live-1');
        expect(stored().activeId).toBe(stored().tabs[1].id);
        expect(deleteRequests).toHaveLength(0);
    });

    it('restores replay tabs after a reload', async () => {
        seed(
            [
                { id: 'a', seq: 1, kind: 'terminal' },
                {
                    id: 'b',
                    seq: 2,
                    kind: 'replay',
                    historyId: 'history-1',
                    historyCommand: 'bash -l',
                    returnToTabId: 'a',
                    title: 'bash -l (history)',
                },
            ],
            'b'
        );
        await mount();
        expect(stored().tabs[1].kind).toBe('replay');
        expect(stored().tabs[1].historyId).toBe('history-1');
        expect(stored().tabs[1].returnToTabId).toBe('a');
        expect(tabs()[1].textContent).toContain('bash -l');
        expect(container.querySelector('.workspace-end-replay')).not.toBeNull();

        // Simulate a page reload: unmount, keep sessionStorage, mount again.
        render(null, container);
        await mount();
        expect(tabs()).toHaveLength(2);
        expect(stored().tabs[1].kind).toBe('replay');
        expect(container.querySelector('.workspace-end-replay')).not.toBeNull();
    });

    it('swallows DELETE failures and 403 without rolling back state', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        deleteMode = 'throw';
        seed([{ id: 'a', seq: 1, kind: 'terminal', sessionId: 'live-1' }], 'a');
        await mount();

        await closeTab(0);
        expect(deleteRequests).toEqual(['http://localhost/sessions/live-1']);
        expect(stored().tabs).toHaveLength(1);
        expect(stored().tabs[0].sessionId).toBeUndefined();

        deleteMode = 'forbidden';
        // Unmount flushes storage, so seed only after the old workspace is gone.
        render(null, container);
        seed([{ id: 'z', seq: 1, kind: 'terminal', sessionId: 'live-2' }], 'z');
        await mount();
        await closeTab(0);
        expect(deleteRequests).toEqual(['http://localhost/sessions/live-1', 'http://localhost/sessions/live-2']);
        expect(stored().tabs).toHaveLength(1);
    });
});
