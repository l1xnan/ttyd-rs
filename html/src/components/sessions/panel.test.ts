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
});
