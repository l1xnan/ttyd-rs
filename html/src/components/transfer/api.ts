import { saveAs } from 'file-saver';
import { chooseWithInput } from '../terminal/xterm/addons/fs-picker';

/** Custom header required by the server; cross-site pages cannot set it. */
export const TRANSFER_HEADER = 'X-TTYD-Transfer';

export interface UploadResult {
    name: string;
    size: number;
    path: string;
}

export class HttpTransferError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HttpTransferError';
    }
}

export function filesUrl(sessionsUrl: string, sessionId: string): string {
    return `${sessionsUrl}/${encodeURIComponent(sessionId)}/files`;
}

export function uploadUrl(baseUrl: string, name: string): string {
    return `${baseUrl}?name=${encodeURIComponent(name)}`;
}

/** Download a file at any absolute or destination-relative path. */
export function downloadPathUrl(sessionsUrl: string, sessionId: string, path: string): string {
    return `${sessionsUrl}/${encodeURIComponent(sessionId)}/download?path=${encodeURIComponent(path)}`;
}

export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

export function parseUploadResult(value: unknown): UploadResult {
    if (!value || typeof value !== 'object') throw new Error('invalid upload result');
    const raw = value as Record<string, unknown>;
    if (typeof raw.name !== 'string' || typeof raw.path !== 'string') {
        throw new Error('invalid upload result');
    }
    return {
        name: raw.name,
        path: raw.path,
        size: typeof raw.size === 'number' ? raw.size : 0,
    };
}

async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
        // fall through to the status line
    }
    return `HTTP ${response.status}`;
}

/** Download through fetch so the CSRF header can be attached. */
export async function downloadFile(url: string, name: string): Promise<void> {
    const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { [TRANSFER_HEADER]: '1' },
    });
    if (!response.ok) {
        throw new HttpTransferError(response.status, await errorMessage(response));
    }
    saveAs(await response.blob(), name);
}

/** XHR is used instead of fetch because only XHR exposes upload progress. */
export function uploadFile(
    url: string,
    file: File,
    onProgress?: (loaded: number, total: number) => void
): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader(TRANSFER_HEADER, '1');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = event => {
            if (event.lengthComputable) onProgress?.(event.loaded, event.total);
        };
        xhr.onload = () => {
            if (xhr.status < 200 || xhr.status >= 300) {
                let message = `HTTP ${xhr.status}`;
                try {
                    const body = JSON.parse(xhr.responseText) as { error?: unknown };
                    if (typeof body?.error === 'string' && body.error) message = body.error;
                } catch {
                    // keep the status line
                }
                reject(new HttpTransferError(xhr.status, message));
                return;
            }
            try {
                resolve(parseUploadResult(JSON.parse(xhr.responseText)));
            } catch (error) {
                reject(error);
            }
        };
        xhr.onerror = () => reject(new Error('network error during upload'));
        xhr.send(file);
    });
}

/** Native file picker; works on plain HTTP, no File System Access API needed. */
export function pickFiles(): Promise<File[] | undefined> {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    return chooseWithInput(input);
}
