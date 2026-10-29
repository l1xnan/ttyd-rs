import type { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { ZmodemAddon, formatTransferProgress, formatTransferSize } from './zmodem';

function fakeTerminal(): Terminal {
    return {
        cols: 80,
        options: { disableStdin: false },
        element: new EventTarget(),
        focus() {},
        onKey() {
            return { dispose() {} };
        },
        onResize() {
            return { dispose() {} };
        },
    } as unknown as Terminal;
}

function addon(options: {
    zmodem: boolean;
    trzsz: boolean;
    sender: (data: string | Uint8Array) => void;
    writer: (data: string | Uint8Array) => void;
}) {
    const created = new ZmodemAddon({
        zmodem: options.zmodem,
        trzsz: options.trzsz,
        windows: false,
        trzszDragInitTimeout: 3000,
        onSend() {},
        sender: options.sender,
        writer: options.writer,
        // trzsz requires these callbacks when it sees a Node.js runtime.
        chooseSendFiles: async () => undefined,
        chooseSaveDirectory: async () => undefined,
    });
    created.activate(fakeTerminal());
    return created;
}

describe('ZMODEM and trzsz', () => {
    it('writes ordinary output to the terminal', () => {
        const written: Array<string | Uint8Array> = [];
        const created = addon({
            zmodem: true,
            trzsz: false,
            sender() {},
            writer(data) {
                written.push(data);
            },
        });

        const bytes = new TextEncoder().encode('hello\r\n');
        created.consume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

        const text = written
            .map(chunk => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)))
            .join('');
        expect(text).toContain('hello');
        created.dispose();
    });

    it('sends trzsz keyboard input once through the filter', () => {
        const sent: Array<string | Uint8Array> = [];
        const created = addon({
            zmodem: false,
            trzsz: true,
            sender(data) {
                sent.push(data);
            },
            writer() {},
        });

        expect(created.handleTerminalInput('pwd\r')).toBe(true);
        expect(created.handleBinaryInput('\x1b[<0;1;1M')).toBe(true);
        const text = sent.map(chunk => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)));
        expect(text).toEqual(['pwd\r', '\x1b[<0;1;1M']);
        created.dispose();
    });

    it('leaves input alone when trzsz is off', () => {
        const sent: Array<string | Uint8Array> = [];
        const created = addon({
            zmodem: true,
            trzsz: false,
            sender(data) {
                sent.push(data);
            },
            writer() {},
        });

        expect(created.handleTerminalInput('pwd\r')).toBe(false);
        expect(sent).toEqual([]);
        created.dispose();
    });

    it('formats an empty file and kilobyte progress', () => {
        expect(formatTransferSize(0, 2)).toBe('0');
        expect(formatTransferSize(1024, 2)).toBe('1.00 KB');
        expect(formatTransferProgress('notes.txt', 0, 0)).toBe('notes.txt 100.00% 0/0\r');
        expect(formatTransferProgress('notes.txt', 512, 1024)).toBe('notes.txt 50.00% 512.00 bytes/1.00 KB\r');
    });
});
