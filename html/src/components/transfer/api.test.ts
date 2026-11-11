import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAs } from 'file-saver';
import {
    HttpTransferError,
    downloadFile,
    downloadPathUrl,
    filesUrl,
    formatSize,
    parseUploadResult,
    uploadFile,
    uploadUrl,
} from './api';

vi.mock('file-saver', () => ({ saveAs: vi.fn() }));

function fakeFetch(status: number, body: unknown) {
    return vi.fn(async (_url?: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        blob: async () => new Blob(['payload']),
    }));
}

class FakeXHR {
    static last?: FakeXHR;
    status = 200;
    responseText = '{}';
    upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
        onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    headers: Record<string, string> = {};
    sent?: File;
    url = '';

    constructor() {
        FakeXHR.last = this;
    }
    open(_method: string, url: string) {
        this.url = url;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    send(file: File) {
        this.sent = file;
    }
    respond(status: number, body: unknown) {
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
    }
}

beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    FakeXHR.last = undefined;
});

describe('transfer urls and formatting', () => {
    it('builds upload and download urls, including a base path', () => {
        const base = filesUrl('https://host/ttyd/sessions', 'abc123');
        expect(base).toBe('https://host/ttyd/sessions/abc123/files');
        expect(uploadUrl(base, '中文 名.txt')).toContain('name=%E4%B8%AD%E6%96%87%20%E5%90%8D.txt');
        expect(downloadPathUrl('https://host/sessions', 'abc', '/etc/hosts')).toBe(
            'https://host/sessions/abc/download?path=%2Fetc%2Fhosts'
        );
    });

    it('formats sizes and parses upload results defensively', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1536)).toBe('1.5 KB');
        expect(formatSize(-1)).toBe('-');
        expect(parseUploadResult({ name: 'a', size: 1, path: '/tmp/a' }).path).toBe('/tmp/a');
        expect(() => parseUploadResult({ name: 'a' })).toThrow();
    });
});

describe('transfer requests', () => {
    it('downloads through saveAs and rejects error statuses', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, {}));
        await downloadFile('/sessions/1/download?path=x', 'a.txt');
        expect(saveAs).toHaveBeenCalledOnce();

        vi.stubGlobal('fetch', fakeFetch(404, { error: 'missing' }));
        await expect(downloadFile('/sessions/1/download?path=x', 'a.txt')).rejects.toMatchObject({
            status: 404,
        } satisfies Partial<HttpTransferError>);
    });

    it('uploads with XHR, forwards progress and resolves the result', async () => {
        vi.stubGlobal('XMLHttpRequest', FakeXHR);
        const progress = vi.fn();
        const file = new File(['hello'], 'hello.txt');
        const pending = uploadFile('/sessions/1/files?name=hello.txt', file, progress);

        const xhr = FakeXHR.last!;
        expect(xhr.headers['X-TTYD-Transfer']).toBe('1');
        expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
        expect(xhr.sent).toBe(file);
        xhr.upload.onprogress?.({ loaded: 2, total: 5, lengthComputable: true });
        expect(progress).toHaveBeenCalledWith(2, 5);

        xhr.respond(200, { name: 'hello.txt', size: 5, path: '/tmp/hello.txt' });
        await expect(pending).resolves.toMatchObject({ path: '/tmp/hello.txt' });
    });

    it('surfaces upload limit errors', async () => {
        vi.stubGlobal('XMLHttpRequest', FakeXHR);
        const pending = uploadFile('/sessions/1/files?name=big', new File(['x'], 'big'));
        FakeXHR.last!.respond(413, { error: 'upload exceeds the configured size limit' });
        await expect(pending).rejects.toMatchObject({ status: 413 });
    });
});
