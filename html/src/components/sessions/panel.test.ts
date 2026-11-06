import { h, render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanel } from './index';

const payload = {
    sessions: [
        { id: 'live-1', owner: 'alice', command: 'bash', state: 'running', attached: 1 },
        { id: 'live-2', owner: 'alice', command: 'htop', state: 'running', attached: 0 },
    ],
    history: [
        {
            id: 'history-1',
            owner: 'alice',
            command: 'bash -l',
            state: 'exited',
            exitCode: 7,
            endedAt: 1762345678901,
        },
    ],
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function response(status: number, body?: unknown): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    } as Response;
}

describe('SessionPanel', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null, container);
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('stays hidden when the server has no sessions endpoint', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(404))
        );

        render(h(SessionPanel, { sessionsUrl: '/sessions' }), container);
        await flush();

        expect(container.querySelector('.session-toggle')).toBeNull();
        expect(container.querySelector('.session-drawer')).toBeNull();
    });

    it('asks for auth when the probe returns 401', async () => {
        const onAuthRequired = vi.fn();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(401))
        );

        render(h(SessionPanel, { sessionsUrl: '/sessions', onAuthRequired }), container);
        await flush();

        expect(onAuthRequired).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.session-toggle')).toBeNull();
    });

    it('lists running and history sessions and forwards attach and replay', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, payload))
        );
        const onAttach = vi.fn();
        const onReplay = vi.fn();

        render(
            h(SessionPanel, {
                sessionsUrl: '/sessions',
                currentSessionId: 'live-1',
                onAttach,
                onReplay,
            }),
            container
        );
        await flush();

        const toggle = container.querySelector('.session-toggle') as HTMLButtonElement;
        expect(toggle).not.toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        toggle.click();
        await flush();

        expect(container.querySelector('.session-drawer')).not.toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        const rows = container.querySelectorAll('.session-row');
        // The attached session is not listed; one running session and one
        // history record remain.
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('htop');
        expect(rows[1].textContent).toContain('bash -l');
        expect(rows[1].textContent).toContain('exit 7');

        (rows[0] as HTMLButtonElement).click();
        await flush();
        expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: 'live-2' }));
        expect(container.querySelector('.session-drawer')).toBeNull();

        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();
        (container.querySelectorAll('.session-row')[1] as HTMLButtonElement).click();
        await flush();
        expect(onReplay).toHaveBeenCalledWith(expect.objectContaining({ id: 'history-1', command: 'bash -l' }));
    });

    it('hides every running session attached by a workspace tab', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, payload))
        );

        render(h(SessionPanel, { sessionsUrl: '/sessions', currentSessionId: ['live-1', 'live-2'] }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        const rows = container.querySelectorAll('.session-row');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('bash -l');
    });

    it('deletes a history record and refreshes the list', async () => {
        let deleted = false;
        const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                deleted = true;
                return response(204);
            }
            return response(200, deleted ? { ...payload, history: [] } : payload);
        });
        vi.stubGlobal('fetch', fetchMock);

        render(h(SessionPanel, { sessionsUrl: '/sessions', currentSessionId: 'live-1' }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();
        expect(container.querySelectorAll('.session-row')).toHaveLength(2);

        const remove = container.querySelector('.session-delete') as HTMLButtonElement;
        expect(remove).not.toBeNull();
        remove.click();
        await flush();

        const deleteCall = fetchMock.mock.calls.find(call => call[1]?.method === 'DELETE');
        expect(deleteCall?.[0]).toBe('/sessions/history-1');
        expect(container.querySelectorAll('.session-row')).toHaveLength(1);
        expect(container.querySelector('.session-delete')).toBeNull();
    });

    it('opens a new tab from the panel instead of reusing the active one', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, payload))
        );
        const onNewTab = vi.fn();

        render(h(SessionPanel, { sessionsUrl: '/sessions', onNewTab }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        const button = container.querySelector('.session-new') as HTMLButtonElement;
        expect(button.textContent).toBe('New tab');
        button.click();
        await flush();

        expect(onNewTab).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.session-drawer')).toBeNull();
    });

    it('ends and archives a running session and reports the live kind', async () => {
        const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
            init?.method === 'DELETE' ? response(204) : response(200, payload)
        );
        vi.stubGlobal('fetch', fetchMock);
        const onDelete = vi.fn();

        render(h(SessionPanel, { sessionsUrl: '/sessions', onDelete }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        const ends = container.querySelectorAll('.session-end');
        expect(ends).toHaveLength(2);
        (ends[0] as HTMLButtonElement).click();
        await flush();

        const deleteCall = fetchMock.mock.calls.find(call => call[1]?.method === 'DELETE');
        expect(deleteCall?.[0]).toBe('/sessions/live-1');
        expect(onDelete).toHaveBeenCalledWith('live-1', 'live');
    });

    it('reports the history kind when a history record is deleted', async () => {
        const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
            init?.method === 'DELETE' ? response(204) : response(200, payload)
        );
        vi.stubGlobal('fetch', fetchMock);
        const onDelete = vi.fn();

        render(h(SessionPanel, { sessionsUrl: '/sessions', onDelete }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();
        (container.querySelector('.session-delete') as HTMLButtonElement).click();
        await flush();

        expect(onDelete).toHaveBeenCalledWith('history-1', 'history');
    });

    it('does not report a deletion when the server refuses it', async () => {
        const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
            init?.method === 'DELETE' ? response(403) : response(200, payload)
        );
        vi.stubGlobal('fetch', fetchMock);
        const onDelete = vi.fn();

        render(h(SessionPanel, { sessionsUrl: '/sessions', onDelete }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();
        (container.querySelector('.session-delete') as HTMLButtonElement).click();
        await flush();

        expect(onDelete).not.toHaveBeenCalled();
        expect(container.querySelector('.session-error')?.textContent).toContain('only delete your own');
    });

    it('highlights every history id replayed by a tab', async () => {
        const twoHistory = {
            sessions: [],
            history: [
                { id: 'history-1', command: 'bash -l', state: 'exited', exitCode: 0 },
                { id: 'history-2', command: 'htop', state: 'exited', exitCode: 1 },
            ],
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, twoHistory))
        );

        render(
            h(SessionPanel, {
                sessionsUrl: '/sessions',
                viewingHistoryIds: ['history-1', 'history-2'],
            }),
            container
        );
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        expect(container.querySelectorAll('.session-row--active')).toHaveLength(2);
    });

    it('still accepts a deprecated single viewingHistoryId', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, payload))
        );

        render(h(SessionPanel, { sessionsUrl: '/sessions', viewingHistoryId: 'history-1' }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        expect(container.querySelectorAll('.session-row--active')).toHaveLength(1);
    });

    it('hints that an already open session switches tabs', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, payload))
        );

        render(h(SessionPanel, { sessionsUrl: '/sessions', openIds: ['live-1'] }), container);
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        const rows = container.querySelectorAll('.session-row');
        expect(rows[0].getAttribute('title')).toContain('Switch to the open tab');
        expect(rows[1].getAttribute('title')).toBe('Open in a new tab');
    });

    it('modifier-click uses the forced-new-tab callbacks', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => response(200, payload))
        );
        const onAttach = vi.fn();
        const onReplay = vi.fn();
        const onAttachInNewTab = vi.fn();
        const onReplayInNewTab = vi.fn();

        render(
            h(SessionPanel, {
                sessionsUrl: '/sessions',
                onAttach,
                onReplay,
                onAttachInNewTab,
                onReplayInNewTab,
            }),
            container
        );
        await flush();
        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();

        container
            .querySelectorAll('.session-row')[0]
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
        await flush();
        expect(onAttachInNewTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'live-1' }));
        expect(onAttach).not.toHaveBeenCalled();

        (container.querySelector('.session-toggle') as HTMLButtonElement).click();
        await flush();
        container
            .querySelectorAll('.session-row')[2]
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
        await flush();
        expect(onReplayInNewTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'history-1' }));
        expect(onReplay).not.toHaveBeenCalled();
    });
});
