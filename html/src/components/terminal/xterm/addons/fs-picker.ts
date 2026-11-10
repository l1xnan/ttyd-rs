import { saveAs } from 'file-saver';

/**
 * Fallback for the File System Access API.
 *
 * trzsz always goes through `window.showOpenFilePicker` / `showDirectoryPicker`
 * in a browser and never calls `chooseSendFiles`, so on a plain HTTP origin the
 * only thing it can do is throw "The File System Access API requires HTTPS
 * except localhost". Browsers hide both functions outside a secure context
 * (https, localhost, 127.0.0.1, file://), which is exactly how a ttyd instance
 * published on a LAN address behaves.
 *
 * The shims below reproduce the small slice of the API that trzsz uses:
 *
 * - upload files: a hidden `<input type="file" multiple>`.
 * - upload a directory: the same input with `webkitdirectory`.
 * - download into a directory: an in-memory directory whose writables hand the
 *   finished blob to `file-saver`, because a non-secure origin cannot write to
 *   a real directory.
 */

type FileSink = (name: string, parts: BlobPart[]) => void;

type DirectoryEntry = FallbackFileHandle | FallbackDirectoryHandle;

/** The subset of `FileSystemWritableFileStream` that trzsz writes to. */
class FallbackWritable {
    private parts: BlobPart[] = [];
    private closed = false;

    constructor(
        private readonly sink: FileSink,
        private readonly name: string
    ) {}

    write(chunk: BufferSource | Blob | string): void {
        if (this.closed) {
            throw new DOMException('The writable stream is closed.', 'InvalidStateError');
        }
        this.parts.push(toBlobPart(chunk));
    }

    /** trzsz calls this synchronously, so the download must start before any await. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        const parts = this.parts;
        this.parts = [];
        this.sink(this.name, parts);
    }

    abort(): void {
        this.closed = true;
        this.parts = [];
    }
}

class FallbackFileHandle {
    readonly kind = 'file';

    constructor(
        readonly name: string,
        private readonly file: File | null,
        private readonly sink?: FileSink
    ) {}

    async getFile(): Promise<File> {
        if (!this.file) {
            throw new DOMException(`"${this.name}" has no content.`, 'NotFoundError');
        }
        return this.file;
    }

    async createWritable(): Promise<FallbackWritable> {
        if (!this.sink) {
            throw new DOMException(`"${this.name}" is read-only.`, 'NoModificationAllowedError');
        }
        return new FallbackWritable(this.sink, this.name);
    }
}

class FallbackDirectoryHandle {
    readonly kind = 'directory';
    private readonly children = new Map<string, DirectoryEntry>();

    constructor(
        readonly name: string,
        private readonly sink?: FileSink
    ) {}

    async *values(): AsyncGenerator<DirectoryEntry> {
        for (const child of this.children.values()) yield child;
    }

    async *entries(): AsyncGenerator<[string, DirectoryEntry]> {
        for (const [name, child] of this.children) yield [name, child];
    }

    async getFileHandle(name: string, options?: { create?: boolean }): Promise<FallbackFileHandle> {
        const existing = this.children.get(name);
        if (existing) {
            if (existing.kind !== 'file') {
                throw new DOMException(`"${name}" is a directory.`, 'TypeMismatchError');
            }
            return existing;
        }
        if (!options?.create) {
            throw new DOMException(`A file named "${name}" does not exist.`, 'NotFoundError');
        }
        const handle = new FallbackFileHandle(name, null, this.sink);
        this.children.set(name, handle);
        return handle;
    }

    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FallbackDirectoryHandle> {
        const existing = this.children.get(name);
        if (existing) {
            if (existing.kind !== 'directory') {
                throw new DOMException(`"${name}" is a file.`, 'TypeMismatchError');
            }
            return existing;
        }
        if (!options?.create) {
            throw new DOMException(`A directory named "${name}" does not exist.`, 'NotFoundError');
        }
        const handle = new FallbackDirectoryHandle(name, this.sink);
        this.children.set(name, handle);
        return handle;
    }

    /** Used while building an upload tree; keeps the traversal synchronous. */
    ensureDirectory(name: string): FallbackDirectoryHandle {
        const existing = this.children.get(name);
        if (existing) {
            return existing as FallbackDirectoryHandle;
        }
        const created = new FallbackDirectoryHandle(name, this.sink);
        this.children.set(name, created);
        return created;
    }

    ensureFile(name: string, file: File): void {
        this.children.set(name, new FallbackFileHandle(name, file, this.sink));
    }
}

function toBlobPart(chunk: BufferSource | Blob | string): BlobPart {
    if (typeof chunk === 'string' || chunk instanceof Blob) return chunk;
    if (chunk instanceof ArrayBuffer) return chunk;
    const view = chunk as ArrayBufferView;
    // Copy: trzsz reuses its send buffer, so a view would be overwritten.
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

function saveDownload(name: string, parts: BlobPart[]): void {
    saveAs(new Blob(parts, { type: 'application/octet-stream' }), name || 'download');
}

/** Split `dir/sub/file.txt` into `['sub', 'file.txt']`, dropping the root name. */
function relativeParts(path: string, root: string): string[] {
    const parts = path.split('/').filter(part => part.length > 0);
    if (parts.length > 1 && parts[0] === root) parts.shift();
    return parts;
}

/**
 * Rebuild the directory tree of a `webkitdirectory` pick as an FSA-like handle,
 * so trzsz can walk it with `values()` / `getFileHandle()` like the real API.
 */
export function directoryHandleFromFiles(
    name: string,
    files: readonly File[],
    sink?: FileSink
): FallbackDirectoryHandle {
    const root = new FallbackDirectoryHandle(name, sink);
    for (const file of files) {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const parts = relativeParts(relative, name);
        if (parts.length === 0) continue;
        let dir = root;
        for (const part of parts.slice(0, -1)) dir = dir.ensureDirectory(part);
        dir.ensureFile(parts[parts.length - 1], file);
    }
    return root;
}

function createInput(directory: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    if (directory) input.setAttribute('webkitdirectory', '');
    document.body.appendChild(input);
    return input;
}

/**
 * Click a hidden file input and resolve with the selection. `undefined` means
 * the user dismissed the dialog; trzsz treats that as `AbortError`.
 */
export function chooseWithInput(input: HTMLInputElement): Promise<File[] | undefined> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (files: File[] | undefined) => {
            if (settled) return;
            settled = true;
            input.removeEventListener('change', onChange);
            input.removeEventListener('cancel', onCancel);
            input.remove();
            resolve(files);
        };
        const onChange = () => finish(input.files ? Array.from(input.files) : undefined);
        const onCancel = () => finish(undefined);
        input.addEventListener('change', onChange);
        input.addEventListener('cancel', onCancel);
        input.click();
    });
}

function aborted(): DOMException {
    // trzsz checks `error.name === 'AbortError'` to mean "user cancelled".
    return new DOMException('The user aborted a request.', 'AbortError');
}

export interface FileSystemPickerTarget {
    showOpenFilePicker?: unknown;
    showDirectoryPicker?: unknown;
}

/**
 * Install the shims when the browser hides the File System Access API.
 *
 * @returns true when the fallback took over (i.e. the origin is not secure).
 */
export function installFileSystemFallback(win: Window = window): boolean {
    const target = win as unknown as FileSystemPickerTarget & {
        showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<unknown>;
        showDirectoryPicker?: (options?: { mode?: string }) => Promise<unknown>;
    };

    const needsOpenPicker = typeof target.showOpenFilePicker !== 'function';
    const needsDirectoryPicker = typeof target.showDirectoryPicker !== 'function';
    if (!needsOpenPicker && !needsDirectoryPicker) return false;

    if (needsOpenPicker) {
        target.showOpenFilePicker = async () => {
            const files = await chooseWithInput(createInput(false));
            if (!files?.length) throw aborted();
            return files.map(file => ({
                kind: 'file',
                name: file.name,
                getFile: () => Promise.resolve(file),
            }));
        };
    }

    if (needsDirectoryPicker) {
        target.showDirectoryPicker = async (options?: { mode?: string }) => {
            // A non-secure origin cannot write into a real directory, so "save
            // into a folder" degrades into one download per file.
            if (options?.mode === 'readwrite') {
                return new FallbackDirectoryHandle('downloads', saveDownload);
            }
            const files = await chooseWithInput(createInput(true));
            if (!files?.length) throw aborted();
            const relative = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
            const name = relative ? relative.split('/')[0] || 'upload' : 'upload';
            return directoryHandleFromFiles(name, files);
        };
    }

    return true;
}
