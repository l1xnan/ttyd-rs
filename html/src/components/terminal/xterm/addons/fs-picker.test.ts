import { describe, expect, it, vi } from 'vitest';
import { chooseWithInput, directoryHandleFromFiles, installFileSystemFallback } from './fs-picker';

function fakeFile(name: string, relative: string, content = 'x'): File {
    const file = new File([content], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: relative });
    return file;
}

function input(): HTMLInputElement {
    const element = document.createElement('input');
    element.type = 'file';
    document.body.appendChild(element);
    return element;
}

describe('File System Access fallback', () => {
    it('installs both pickers when the browser hides them', () => {
        const win = {} as Window;
        expect(installFileSystemFallback(win)).toBe(true);
        expect(typeof (win as unknown as Record<string, unknown>).showOpenFilePicker).toBe('function');
        expect(typeof (win as unknown as Record<string, unknown>).showDirectoryPicker).toBe('function');
    });

    it('is idempotent and leaves a native implementation alone', () => {
        const win = {} as Window;
        installFileSystemFallback(win);
        expect(installFileSystemFallback(win)).toBe(false);

        const native = vi.fn();
        const secure = { showOpenFilePicker: native, showDirectoryPicker: vi.fn() } as unknown as Window;
        expect(installFileSystemFallback(secure)).toBe(false);
        expect((secure as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker).toBe(native);
    });

    it('resolves with the selected files and removes the input', async () => {
        const element = input();
        const pending = chooseWithInput(element);
        const file = new File(['hello'], 'hello.txt');
        Object.defineProperty(element, 'files', { value: [file] });

        element.dispatchEvent(new Event('change'));
        await expect(pending).resolves.toEqual([file]);
        expect(element.isConnected).toBe(false);
    });

    it('resolves with undefined when the dialog is dismissed', async () => {
        const element = input();
        const pending = chooseWithInput(element);
        element.dispatchEvent(new Event('cancel'));
        await expect(pending).resolves.toBeUndefined();
        expect(element.isConnected).toBe(false);
    });

    it('turns a dismissed open dialog into AbortError for trzsz', async () => {
        const win = {} as Window;
        installFileSystemFallback(win);
        const pick = (win as unknown as { showOpenFilePicker: () => Promise<unknown> }).showOpenFilePicker;
        const proto = HTMLInputElement.prototype;
        const click = proto.click;
        proto.click = function (this: HTMLInputElement) {
            this.dispatchEvent(new Event('cancel'));
        };
        try {
            await expect(pick()).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            proto.click = click;
        }
    });

    it('returns file handles whose getFile yields the picked files', async () => {
        const win = {} as Window;
        installFileSystemFallback(win);
        const pick = (
            win as unknown as {
                showOpenFilePicker: () => Promise<Array<{ getFile: () => Promise<File> }>>;
            }
        ).showOpenFilePicker;
        const proto = HTMLInputElement.prototype;
        const click = proto.click;
        proto.click = function (this: HTMLInputElement) {
            Object.defineProperty(this, 'files', {
                value: [new File(['hello'], 'hello.txt')],
            });
            this.dispatchEvent(new Event('change'));
        };
        try {
            const handles = await pick();
            await expect(handles[0].getFile()).resolves.toMatchObject({ name: 'hello.txt' });
        } finally {
            proto.click = click;
        }
    });
});

describe('directoryHandleFromFiles', () => {
    it('rebuilds the nested tree and drops the root segment', async () => {
        const root = directoryHandleFromFiles('project', [
            fakeFile('README.md', 'project/README.md'),
            fakeFile('main.rs', 'project/src/main.rs'),
            fakeFile('lib.rs', 'project/src/deep/lib.rs'),
        ]);

        const paths: string[] = [];
        const walk = async (dir: ReturnType<typeof directoryHandleFromFiles>, prefix: string) => {
            for await (const entry of dir.values()) {
                const path = `${prefix}/${entry.name}`;
                if (entry.kind === 'file') {
                    paths.push(path);
                } else {
                    await walk(entry as ReturnType<typeof directoryHandleFromFiles>, path);
                }
            }
        };
        await walk(root, '');

        expect(paths).toEqual(['/README.md', '/src/main.rs', '/src/deep/lib.rs']);
    });

    it('rejects a missing entry unless create is requested', async () => {
        const root = directoryHandleFromFiles('project', []);
        await expect(root.getFileHandle('nope.txt')).rejects.toThrow(/does not exist/);
        await expect(root.getDirectoryHandle('nope')).rejects.toThrow(/does not exist/);
        await expect(root.getFileHandle('new.txt', { create: true })).resolves.toBeTruthy();
    });
});

describe('virtual download directory', () => {
    it('streams the written chunks into the sink on close', async () => {
        const saved: Array<{ name: string; blob: Blob }> = [];
        const root = directoryHandleFromFiles('downloads', [], (name, parts) => {
            saved.push({ name, blob: new Blob(parts) });
        });

        const handle = await root.getFileHandle('report.txt', { create: true });
        const writable = await handle.createWritable();
        writable.write(new Uint8Array([1, 2, 3]));
        writable.write(new Uint8Array([4, 5]));
        writable.close();

        expect(saved.map(entry => entry.name)).toEqual(['report.txt']);
        expect(saved[0].blob.size).toBe(5);
        expect(new Uint8Array(await saved[0].blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it('copies the buffer instead of keeping a view on it', async () => {
        const saved: Blob[] = [];
        const root = directoryHandleFromFiles('downloads', [], (_name, parts) => {
            saved.push(new Blob(parts));
        });

        const source = new Uint8Array([9, 9, 9]);
        const handle = await root.getFileHandle('chunk.bin', { create: true });
        const writable = await handle.createWritable();
        writable.write(source);
        source.fill(0);
        writable.close();

        expect(new Uint8Array(await saved[0].arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
    });

    it('writes a file once even when close is called twice', async () => {
        const saved: Blob[] = [];
        const root = directoryHandleFromFiles('downloads', [], (_name, parts) => {
            saved.push(new Blob(parts));
        });

        const handle = await root.getFileHandle('a.bin', { create: true });
        const writable = await handle.createWritable();
        writable.write(new Uint8Array([7]));
        writable.close();
        writable.close();

        expect(saved).toHaveLength(1);
    });

    it('keeps an upload tree read-only', async () => {
        const root = directoryHandleFromFiles('project', [fakeFile('README.md', 'project/README.md')]);
        const file = await root.getFileHandle('README.md');
        await expect(file.createWritable()).rejects.toThrow(/read-only/);
        expect((await file.getFile()).name).toBe('README.md');
    });
});
