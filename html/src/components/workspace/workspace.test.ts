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

describe('Workspace', () => {
    let container: HTMLElement;
    let key: string;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        key = workspaceStorageKey(window.location.pathname);
        window.sessionStorage.clear();
        // Sessions are available so the panel really renders; the token is
        // refused so terminals stop before opening xterm.js or a WebSocket.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL, init?: RequestInit) => {
                if (init?.method === 'DELETE') return response(204);
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

    interface StoredTab {
        id: string;
        kind?: string;
        sessionId?: string;
        title?: string;
        historyId?: string;
        returnToTabId?: string;
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

    function clickAdd() {
        (container.querySelector('.workspace-add') as HTMLButtonElement).click();
    }

    it('migrates a legacy bare session id into a single tab', async () => {
        window.sessionStorage.setItem(key, 'legacy-session');
        render(h(Workspace, props), container);
        await flush();

        expect(tabs()).toHaveLength(1);
        const state = stored();
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].sessionId).toBe('legacy-session');
        expect(state.tabs[0].kind).toBe('terminal');
        expect(state.activeId).toBe(state.tabs[0].id);
        expect(container.querySelectorAll('.terminal-pane')).toHaveLength(1);
        expect(container.querySelector('.workspace-tabbar-actions')).not.toBeNull();
        expect(container.querySelector('.session-toggle')).not.toBeNull();
    });

    it('adds tabs and replaces the last closed tab with a fresh one', async () => {
        render(h(Workspace, props), container);
        await flush();
        expect(tabs()).toHaveLength(1);

        clickAdd();
        await flush();
        expect(tabs()).toHaveLength(2);
        expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
        expect(container.querySelectorAll('.terminal-pane')).toHaveLength(2);

        const firstId = stored().tabs[0].id;
        (tabs()[0].querySelector('.workspace-tab-close') as HTMLButtonElement).click();
        await flush();
        expect(tabs()).toHaveLength(1);
        expect(stored().tabs[0].id).not.toBe(firstId);

        const lastId = stored().tabs[0].id;
        (tabs()[0].querySelector('.workspace-tab-close') as HTMLButtonElement).click();
        await flush();
        expect(tabs()).toHaveLength(1);
        expect(stored().tabs[0].id).not.toBe(lastId);
        expect(stored().tabs[0].sessionId).toBeUndefined();
    });

    it('keeps only the active pane visible', async () => {
        render(h(Workspace, props), container);
        await flush();
        clickAdd();
        await flush();

        const panes = container.querySelectorAll('.terminal-pane');
        expect(panes).toHaveLength(2);
        expect((panes[0] as HTMLElement).style.visibility).toBe('hidden');
        expect((panes[1] as HTMLElement).style.visibility).toBe('visible');

        (tabs()[0] as HTMLElement).click();
        await flush();
        expect((container.querySelectorAll('.terminal-pane')[0] as HTMLElement).style.visibility).toBe('visible');
        expect((container.querySelectorAll('.terminal-pane')[1] as HTMLElement).style.visibility).toBe('hidden');
    });
});
