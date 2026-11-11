import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { TransferPanel, type TransferPanelProps } from './index';

vi.mock('file-saver', () => ({ saveAs: vi.fn() }));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function props(overrides: Partial<TransferPanelProps> = {}): TransferPanelProps {
    return {
        open: true,
        mode: 'download',
        sessionsUrl: 'http://localhost/sessions',
        sessionId: 'abc123',
        maxUpload: 1024,
        transferDir: '/srv/uploads',
        followCwd: false,
        onClose: () => {},
        ...overrides,
    };
}

function fakeFetch(status: number, body: unknown) {
    return vi.fn(async (_url?: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        blob: async () => new Blob(['x']),
    }));
}

class AutoXHR {
    upload: { onprogress: unknown } = { onprogress: null };
    status = 200;
    responseText = JSON.stringify({ name: 'a.txt', size: 2, path: '/srv/uploads/a.txt' });
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    send() {
        this.onload?.();
    }
}

let container: HTMLElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.unstubAllGlobals();
});

afterEach(() => {
    render(null, container);
    container.remove();
    vi.restoreAllMocks();
});

describe('TransferPanel', () => {
    it('downloads the server path typed into the input', async () => {
        const fetchMock = fakeFetch(200, {});
        vi.stubGlobal('fetch', fetchMock);
        render(h(TransferPanel, props()), container);
        await flush();

        expect(container.querySelector('.modal--dark')).not.toBeNull();
        const input = container.querySelector('.transfer-input') as HTMLInputElement;
        input.value = '/etc/hosts';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();

        (container.querySelector('.transfer-button') as HTMLButtonElement).click();
        await flush();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain('path=/etc/hosts');
    });

    it('reports download errors', async () => {
        vi.stubGlobal('fetch', fakeFetch(403, { error: 'outside --http-transfer-root' }));
        render(h(TransferPanel, props()), container);
        await flush();

        const input = container.querySelector('.transfer-input') as HTMLInputElement;
        input.value = '/etc/shadow';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
        (container.querySelector('.transfer-button') as HTMLButtonElement).click();
        await flush();

        expect(container.querySelector('.transfer-error')?.textContent).toContain('outside --http-transfer-root');
    });

    it('shows the destination and the uploaded path', async () => {
        vi.stubGlobal('XMLHttpRequest', AutoXHR);
        render(h(TransferPanel, props({ mode: 'upload', droppedFiles: [new File(['hi'], 'a.txt')] })), container);
        await flush();
        await flush();

        expect(container.querySelector('.transfer-cwd')?.textContent).toBe('/srv/uploads');
        expect(container.querySelector('.transfer-notice')?.textContent).toContain('/srv/uploads/a.txt');
    });

    it('describes the fallback when the shell cwd is followed', async () => {
        render(h(TransferPanel, props({ mode: 'download', followCwd: true })), container);
        await flush();
        expect(container.querySelector('.transfer-title')?.textContent).toBe('Download file');
        expect(container.querySelector('.transfer-input')).not.toBeNull();
    });

    it('rejects files over the server size limit before uploading', async () => {
        vi.stubGlobal('XMLHttpRequest', AutoXHR);
        render(
            h(
                TransferPanel,
                props({
                    mode: 'upload',
                    maxUpload: 1,
                    droppedFiles: [new File(['hello'], 'big.txt')],
                })
            ),
            container
        );
        await flush();
        expect(container.querySelector('.transfer-error')?.textContent).toContain('exceeds');
    });
});
