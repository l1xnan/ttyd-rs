import { bind } from 'decko';
import { saveAs } from 'file-saver';
import { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import Zmodem from 'zmodem-ts';
import { TrzszFilter } from 'trzsz';
import { installFileSystemFallback } from './fs-picker';

const SEND_CHUNK_SIZE = 64 * 1024;

const SIZE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Human-readable size used in the ZMODEM progress line. */
export function formatTransferSize(bytes: number, precision: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes === 0) return '0';
    const num = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
    const value = (bytes / 1024 ** num).toFixed(precision);
    return `${value} ${SIZE_UNITS[num]}`;
}

export function formatTransferProgress(name: string, offset: number, size: number): string {
    const percent = size > 0 ? ((100 * offset) / size).toFixed(2) : '100.00';
    return `${name} ${percent}% ${formatTransferSize(offset, 2)}/${formatTransferSize(size, 2)}\r`;
}

interface ZmodemFileDetails {
    name: string;
    size: number;
}

interface ZmodemProgress {
    get_details(): ZmodemFileDetails;
    get_offset(): number;
}

interface ZmodemTransfer extends ZmodemProgress {
    send(data: Uint8Array): void;
    end(data?: Uint8Array): Promise<unknown>;
}

interface ZmodemOffer extends ZmodemProgress {
    on(event: 'input' | 'complete', listener: () => void): void;
    accept(): Promise<Uint8Array[]>;
}

interface ZmodemSession {
    type: 'send' | 'receive';
    on(event: 'session_end', listener: () => void): void;
    on(event: 'offer', listener: (offer: ZmodemOffer) => void): void;
    send_offer(details: {
        name: string;
        size: number;
        mtime: Date;
        files_remaining: number;
        bytes_remaining: number;
    }): Promise<ZmodemTransfer | '' | undefined>;
    start(): Promise<unknown>;
    close(): Promise<unknown>;
}

interface ZmodemDetection {
    confirm(): ZmodemSession;
    deny(): void;
}

export interface ZmodeOptions {
    zmodem: boolean;
    trzsz: boolean;
    windows: boolean;
    trzszDragInitTimeout: number;
    /** Upper bound of one trzsz `#DATA:` chunk, in bytes before encoding. */
    maxDataChunkSize?: number;
    onSend: () => void;
    sender: (data: string | Uint8Array) => void;
    writer: (data: string | Uint8Array) => void;
    /**
     * Required only when trzsz detects a Node.js runtime (its own tests and
     * Electron). The browser build ignores these and uses the file picker.
     */
    chooseSendFiles?: (directory?: boolean) => Promise<string[] | undefined>;
    chooseSaveDirectory?: () => Promise<string | undefined>;
}

export class ZmodemAddon implements ITerminalAddon {
    private disposables: IDisposable[] = [];
    private terminal: Terminal;
    private sentry: InstanceType<typeof Zmodem.Sentry>;
    private session: ZmodemSession | null = null;
    private denier: (() => void) | null = null;
    private trzszFilter?: TrzszFilter;

    constructor(private options: ZmodeOptions) {}

    activate(terminal: Terminal) {
        this.terminal = terminal;
        if (this.options.zmodem) this.zmodemInit();
        if (this.options.trzsz) this.trzszInit();
    }

    dispose() {
        // A transfer may still hold timers and promises whose sender is bound to
        // the Xterm instance. Stop it before the socket is replaced, otherwise
        // the stale `#ACT:` / `#DATA:` could be written into the new connection.
        try {
            this.trzszFilter?.stopTransferringFiles();
        } catch (e) {
            console.error('[ttyd] zmodem dispose: ', e);
        }
        this.trzszFilter = undefined;
        this.session = null;
        this.denier = null;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    consume(data: ArrayBuffer) {
        try {
            if (this.options.trzsz) {
                this.trzszFilter?.processServerOutput(data);
            } else {
                this.sentry.consume(data);
            }
        } catch (e) {
            console.error('[ttyd] zmodem consume: ', e);
            this.reset();
        }
    }

    /**
     * Pass keyboard input through trzsz so an in-progress transfer can swallow
     * keystrokes and handle Ctrl+C. Returns false when trzsz is inactive and
     * the caller should forward the input itself.
     */
    handleTerminalInput(data: string): boolean {
        if (!this.options.trzsz || !this.trzszFilter) return false;
        this.trzszFilter.processTerminalInput(data);
        return true;
    }

    /** Same as {@link handleTerminalInput} for mouse and other binary input. */
    handleBinaryInput(data: string): boolean {
        if (!this.options.trzsz || !this.trzszFilter) return false;
        this.trzszFilter.processBinaryInput(data);
        return true;
    }

    /** Reject a pending upload and return the terminal to normal input. */
    cancelSend(): void {
        const deny = this.denier;
        this.denier = null;
        try {
            deny?.();
        } catch (e) {
            console.error('[ttyd] zmodem cancel: ', e);
        }
        this.reset();
    }

    @bind
    private reset() {
        this.session = null;
        this.denier = null;
        this.terminal.options.disableStdin = false;
        this.terminal.focus();
    }

    private addDisposableListener(target: EventTarget, type: string, listener: EventListener) {
        target.addEventListener(type, listener);
        this.disposables.push({ dispose: () => target.removeEventListener(type, listener) });
    }

    @bind
    private trzszInit() {
        const { terminal } = this;
        const { sender, writer, zmodem } = this.options;
        // trzsz only talks to the File System Access API in a browser, and that
        // API is hidden on insecure origins (plain HTTP on a LAN address). The
        // fallback restores the pickers through a hidden file input.
        if (installFileSystemFallback()) {
            console.warn(
                '[ttyd] File System Access API is unavailable on this origin; ' +
                    'trzsz falls back to a native file picker. Use HTTPS or localhost ' +
                    'to pick and save whole directories.'
            );
        }
        this.trzszFilter = new TrzszFilter({
            writeToTerminal: data => {
                if (!this.trzszFilter?.isTransferringFiles() && zmodem) {
                    this.sentry.consume(data);
                } else {
                    writer(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
                }
            },
            sendToServer: data => sender(data),
            terminalColumns: terminal.cols,
            isWindowsShell: this.options.windows,
            dragInitTimeout: this.options.trzszDragInitTimeout,
            maxDataChunkSize: this.options.maxDataChunkSize,
            chooseSendFiles: this.options.chooseSendFiles,
            chooseSaveDirectory: this.options.chooseSaveDirectory,
        });
        const element = terminal.element as EventTarget;
        this.addDisposableListener(element, 'dragover', event => event.preventDefault());
        this.addDisposableListener(element, 'drop', event => {
            event.preventDefault();
            this.trzszFilter
                ?.uploadFiles((event as DragEvent).dataTransfer?.items as DataTransferItemList)
                .then(() => console.log('[ttyd] upload success'))
                .catch(err => console.log('[ttyd] upload failed: ' + err));
        });
        this.disposables.push(terminal.onResize(size => this.trzszFilter?.setTerminalColumns(size.cols)));
    }

    @bind
    private zmodemInit() {
        const { sender, writer } = this.options;
        const { terminal, reset, zmodemDetect } = this;
        this.sentry = new Zmodem.Sentry({
            to_terminal: octets => writer(new Uint8Array(octets)),
            sender: octets => sender(new Uint8Array(octets)),
            on_retract: () => reset(),
            on_detect: detection => zmodemDetect(detection),
        });
        this.disposables.push(
            terminal.onKey(e => {
                const event = e.domEvent;
                if (event.ctrlKey && event.key === 'c') {
                    if (this.denier) this.denier();
                }
            })
        );
    }

    @bind
    private zmodemDetect(detection: ZmodemDetection): void {
        const { terminal, receiveFile } = this;
        terminal.options.disableStdin = true;

        this.denier = () => detection.deny();
        this.session = detection.confirm();
        this.session.on('session_end', () => this.reset());

        if (this.session.type === 'send') {
            this.options.onSend();
        } else {
            receiveFile();
        }
    }

    @bind
    public sendFile(files: FileList) {
        const { session } = this;
        if (!session) return;

        this.sendFiles(session, files)
            .then(() => session.close())
            .catch(e => {
                console.error('[ttyd] zmodem send: ', e);
                this.reset();
            });
    }

    private async sendFiles(session: ZmodemSession, files: FileList) {
        const batch = Array.from(files);
        let bytesRemaining = batch.reduce((total, file) => total + file.size, 0);

        for (let i = 0; i < batch.length; i++) {
            const file = batch[i];
            const transfer = await session.send_offer({
                name: file.name,
                size: file.size,
                mtime: new Date(file.lastModified),
                files_remaining: batch.length - i,
                bytes_remaining: bytesRemaining,
            });
            bytesRemaining -= file.size;

            if (!transfer) continue;

            let offset = transfer.get_offset();
            if (offset >= file.size) {
                await transfer.end();
                this.writeProgress(transfer);
            } else {
                while (offset < file.size) {
                    const end = Math.min(offset + SEND_CHUNK_SIZE, file.size);
                    const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
                    offset = end;

                    if (offset < file.size) {
                        transfer.send(chunk);
                        this.writeProgress(transfer);
                    } else {
                        const completed = transfer.end(chunk);
                        this.writeProgress(transfer);
                        await completed;
                    }
                }
            }
        }
    }

    @bind
    private receiveFile() {
        const { session, writeProgress } = this;
        if (!session) return;

        session.on('offer', offer => {
            offer.on('input', () => writeProgress(offer));
            offer
                .accept()
                .then(payloads => {
                    const blob = new Blob(payloads as BlobPart[], { type: 'application/octet-stream' });
                    saveAs(blob, offer.get_details().name);
                })
                .catch(() => this.reset());
        });

        session.start();
    }

    @bind
    private writeProgress(progress: ZmodemProgress) {
        const file = progress.get_details();
        this.options.writer(formatTransferProgress(file.name, progress.get_offset(), file.size));
    }
}
