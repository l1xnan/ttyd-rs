import { bind } from 'decko';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { OverlayAddon } from './addons/overlay';
import { ZmodemAddon } from './addons/zmodem';
import { buildHandshake, parseReadonlyFrame } from './handshake';
import { bypassesTransferFilter, REPLAY_OUTPUT } from './frames';
import {
    activePreferenceEntries,
    parseQueryOptions,
    resolveSessionTimeout,
    type ClientOptions,
    type RendererType,
} from './prefs';
import { sixelPrimaryDeviceAttributes } from './sixel';

import '@xterm/xterm/css/xterm.css';

export { DEFAULT_CLIENT_OPTIONS, type ClientOptions, type RendererType } from './prefs';

interface TtydTerminal extends Terminal {
    fit(): void;
}

declare global {
    interface Window {
        term: TtydTerminal;
    }
}

enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',
    SET_SESSION = '3',
    READONLY = '4',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
}

type Preferences = ITerminalOptions & ClientOptions;

export interface FlowControl {
    limit: number;
    highWater: number;
    lowWater: number;
}

export interface XtermOptions {
    wsUrl: string;
    tokenUrl: string;
    sessionsUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
    sessionTimeout: number;
    /** Live session id owned by the workspace; only read once at construction. */
    initialSessionId?: string;
    /** Whether this terminal is the visible tab at construction time. */
    active?: boolean;
    onAuthRequired?: () => void;
    onHistoryChange?: (id: string | undefined) => void;
    /** Authoritative persistence signal for the live PTY session id. */
    onLiveSessionIdChange?: (id: string | undefined) => void;
    /** Shell (OSC) title, used to label the tab. */
    onTitleChange?: (title: string | undefined) => void;
    onLeaveAlertDisabled?: () => void;
    onRequestClose?: () => void;
    onConnectionFailed?: (message: string) => void;
}

const DEFAULT_TITLE = 'ttyd - Terminal';

/**
 * Upper bound of one trzsz `#DATA:` chunk before encoding. The server rejects
 * `0` input payloads above 256 KiB, and trzsz can double a chunk with escape
 * sequences (base64 is ~1.34x), so 96 KiB keeps every frame well inside it.
 */
const MAX_TRZSZ_DATA_CHUNK = 96 * 1024;

function toDisposable(f: () => void): IDisposable {
    return { dispose: f };
}

function addEventListener(target: EventTarget, type: string, listener: EventListener): IDisposable {
    target.addEventListener(type, listener);
    return toDisposable(() => target.removeEventListener(type, listener));
}

export class Xterm {
    private disposables: IDisposable[] = [];
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();
    private written = 0;
    private pending = 0;

    private terminal: Terminal;
    private fitAddon = new FitAddon();
    private overlayAddon = new OverlayAddon();
    private clipboardAddon = new ClipboardAddon();
    private webLinksAddon = new WebLinksAddon();
    private webglAddon?: WebglAddon;
    private zmodemAddon?: ZmodemAddon;
    private sixelInstalled = false;

    private socket?: WebSocket;
    private socketDisposables: IDisposable[] = [];
    private token: string;
    private opened = false;
    private title?: string;
    private titleFixed?: string;
    private resizeOverlay = true;
    private reconnect = true;
    private doReconnect = true;
    private closeOnDisconnect = false;
    private sessionId?: string;
    private active = false;
    private desiredTitle = DEFAULT_TITLE;
    private closed = false;

    /// Read-only history replay state. `attachOnly` selects the replay
    /// handshake; `requestedSession` is the history id, never the live id.
    private readOnly = false;
    private attachOnly = false;
    private requestedSession?: string;
    private exitCode?: number;
    private historyCommand?: string;
    private connectNotice?: string;

    private writeFunc = (data: ArrayBuffer) => this.writeData(new Uint8Array(data));

    constructor(
        private options: XtermOptions,
        private sendCb: () => void
    ) {
        this.sessionId = options.initialSessionId;
        this.active = options.active === true;
    }

    /**
     * Clear listeners and transient addons between socket connections. This is
     * intentionally not a full teardown: reconnecting keeps the xterm instance.
     */
    private reset() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
        this.socketDisposables.length = 0;
        this.zmodemAddon = undefined;
        this.sixelInstalled = false;
        this.writeFunc = data => this.writeData(new Uint8Array(data));
    }

    @bind
    public close() {
        this.reconnect = false;
        this.doReconnect = false;
        this.teardownSocket();
        this.reset();
    }

    /** Full teardown, only used when the tab itself is removed. */
    @bind
    public dispose() {
        if (this.closed) return;
        this.closed = true;
        this.close();
        if (this.active && (window as unknown as { term?: TtydTerminal }).term === this.terminal) {
            delete (window as unknown as { term?: TtydTerminal }).term;
        }
        try {
            this.terminal?.dispose();
        } catch {
            // A terminal that was never opened has nothing to dispose.
        }
    }

    /** Only the active tab owns the global terminal handle. */
    @bind
    public setActive(active: boolean) {
        if (this.active === active) return;
        this.active = active;
        if (!active) return;

        // `open()` assigns the global handle for the initially active tab; a
        // tab activated before its token fetch finishes has no terminal yet.
        if (this.terminal) {
            window.term = this.terminal as TtydTerminal;
            window.term.fit = () => this.fit();
        }
        document.title = this.desiredTitle;
        this.fit();
        this.focus();
    }

    @bind
    public fit() {
        if (!this.active || !this.terminal?.element) return;
        this.fitAddon.fit();
    }

    @bind
    public focus() {
        if (this.active) this.terminal?.focus();
    }

    /** A live, writable PTY connection (history replays do not count). */
    public hasLiveSession(): boolean {
        return !this.readOnly && !this.attachOnly && this.socket?.readyState === WebSocket.OPEN;
    }

    /** The one place allowed to write document.title; hidden tabs only cache it. */
    private setDocumentTitle(text: string) {
        this.desiredTitle = text;
        if (this.active) document.title = text;
    }

    /** Authoritative live session id change, forwarded to the workspace. */
    private setLive(id: string | undefined) {
        if (id !== undefined && (id === '' || id.length > 128)) return;
        this.sessionId = id;
        this.options.onLiveSessionIdChange?.(id);
    }

    /**
     * Drop the current WebSocket listeners before closing it. This keeps the
     * old socket's close event from reconnecting or clobbering the session
     * state when the user switches to another session.
     */
    private teardownSocket() {
        const socket = this.socket;
        this.socket = undefined;
        for (const disposable of this.socketDisposables) {
            disposable.dispose();
        }
        this.socketDisposables.length = 0;
        if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
        }
    }

    /// Attach this tab to a live session.
    @bind
    public attachSession(id: string) {
        if (!id || !this.terminal) return;

        const { terminal } = this;
        this.teardownSocket();
        this.reset();
        this.attachOnly = false;
        this.readOnly = false;
        this.requestedSession = undefined;
        this.exitCode = undefined;
        this.historyCommand = undefined;
        this.connectNotice = 'Attached';
        terminal.options.disableStdin = false;
        this.clearShellTitle();
        this.setLive(id);
        this.options.onHistoryChange?.(undefined);
        this.connect();
    }

    /**
     * Configure a read-only replay without touching the socket or the tab
     * label. `clearShellTitle` is deliberately not called here: it would emit
     * `onTitleChange(undefined)` and wipe the replay tab's history label.
     */
    private enterReplayMode(id: string, command: string) {
        this.attachOnly = true;
        this.readOnly = true;
        this.requestedSession = id;
        this.historyCommand = command !== '' ? command : id;
        this.exitCode = undefined;
        this.connectNotice = undefined;
        // A replay id must never become the live session. Only the in-memory
        // id is cleared; the workspace keeps the persisted live session id.
        this.sessionId = undefined;
        this.terminal.options.disableStdin = true;
        this.setDocumentTitle(`${this.historyCommand} (ended)`);
    }

    /** Start a replay tab right after open(), before any socket exists. */
    @bind
    public startReplay(id: string, command: string) {
        if (!id || !this.terminal) return;
        this.enterReplayMode(id, command);
        this.connect();
    }

    /// Show a read-only replay of an ended session (legacy in-place path).
    @bind
    public replayHistory(id: string, command: string) {
        if (!id || !this.terminal) return;

        this.teardownSocket();
        this.reset();
        this.enterReplayMode(id, command);
        this.terminal.reset();
        this.clearShellTitle();
        this.options.onHistoryChange?.(id);
        this.connect();
    }

    /// Detach from the current session and start a brand new one.
    @bind
    public newSession() {
        if (!this.terminal) return;

        const { terminal } = this;
        this.teardownSocket();
        this.reset();
        this.attachOnly = false;
        this.readOnly = false;
        this.requestedSession = undefined;
        this.exitCode = undefined;
        this.historyCommand = undefined;
        this.connectNotice = 'New session';
        terminal.options.disableStdin = false;
        this.clearShellTitle();
        this.setLive(undefined);
        this.options.onHistoryChange?.(undefined);
        this.connect();
    }

    private clearShellTitle() {
        this.title = undefined;
        this.setDocumentTitle(this.titleFixed ?? DEFAULT_TITLE);
        this.options.onTitleChange?.(undefined);
    }

    @bind
    private register<T extends IDisposable>(d: T): T {
        this.disposables.push(d);
        return d;
    }

    @bind
    public sendFile(files: FileList) {
        this.zmodemAddon?.sendFile(files);
    }

    public cancelSend() {
        this.zmodemAddon?.cancelSend();
    }

    @bind
    public async refreshToken(): Promise<boolean> {
        try {
            const resp = await fetch(this.options.tokenUrl, {
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (resp.status === 401) {
                this.options.onAuthRequired?.();
                return false;
            }
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const json = await resp.json();
            if (typeof json?.token !== 'string') {
                throw new Error('invalid token response');
            }
            this.token = json.token;
            return true;
        } catch (e) {
            console.error(`[ttyd] fetch ${this.options.tokenUrl}: `, e);
            return false;
        }
    }

    /// Resolve the timeout sent to the server for this page.
    private sessionTimeout(): number {
        return resolveSessionTimeout(this.options.sessionTimeout, window.location.search);
    }

    @bind
    public open(parent: HTMLElement) {
        this.terminal = new Terminal(this.options.termOptions);
        const { terminal, fitAddon, overlayAddon, clipboardAddon, webLinksAddon } = this;
        if (this.active) {
            window.term = terminal as TtydTerminal;
            window.term.fit = () => this.fit();
        }

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        terminal.loadAddon(clipboardAddon);
        terminal.loadAddon(webLinksAddon);

        terminal.open(parent);
        // Hidden panes keep their layout but must not be fitted (0 columns).
        this.fit();
    }

    @bind
    private initListeners() {
        const { terminal, overlayAddon, register, sendData } = this;
        register(
            terminal.onTitleChange(data => {
                // The ended-history title is set from the replay frame instead.
                if (this.readOnly) return;
                if (data && data !== '' && !this.titleFixed) {
                    this.setDocumentTitle(data + ' | ' + (this.title ?? DEFAULT_TITLE));
                    this.options.onTitleChange?.(data);
                }
            })
        );
        register(
            terminal.onData(data => {
                if (this.readOnly) return;
                if (this.zmodemAddon?.handleTerminalInput(data)) return;
                sendData(data);
            })
        );
        register(
            terminal.onBinary(data => {
                if (this.readOnly) return;
                if (this.zmodemAddon?.handleBinaryInput(data)) return;
                sendData(Uint8Array.from(data, v => v.charCodeAt(0)));
            })
        );
        register(
            terminal.onResize(({ cols, rows }) => {
                const msg = JSON.stringify({ columns: cols, rows: rows });
                this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
                if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
            })
        );
        register(
            terminal.onSelectionChange(() => {
                if (!this.active) return;
                if (this.terminal.getSelection() === '') return;
                try {
                    document.execCommand('copy');
                } catch {
                    return;
                }
                this.overlayAddon?.showOverlay('\u2702', 200);
            })
        );
        // Window-level resize / beforeunload listeners live in the workspace so
        // they are registered once instead of once per tab.
    }

    @bind
    public writeData(data: string | Uint8Array) {
        const { terminal, textEncoder } = this;
        const { limit, highWater, lowWater } = this.options.flowControl;

        this.written += data.length;
        if (this.written > limit) {
            terminal.write(data, () => {
                this.pending = Math.max(this.pending - 1, 0);
                // Flow control is pointless on the read-only replay socket and
                // sending frame '3' there is not allowed.
                if (this.pending < lowWater && !this.readOnly) {
                    this.socket?.send(textEncoder.encode(Command.RESUME));
                }
            });
            this.pending++;
            this.written = 0;
            if (this.pending > highWater && !this.readOnly) {
                this.socket?.send(textEncoder.encode(Command.PAUSE));
            }
        } else {
            terminal.write(data);
        }
    }

    @bind
    public sendData(data: string | Uint8Array) {
        // The replay socket discards input; keep the view strictly read-only.
        if (this.readOnly) return;
        const { socket, textEncoder } = this;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (typeof data === 'string') {
            const payload = new Uint8Array(data.length * 3 + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            const stats = textEncoder.encodeInto(data, payload.subarray(1));
            socket.send(payload.subarray(0, (stats.written as number) + 1));
        } else {
            const payload = new Uint8Array(data.length + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            payload.set(data, 1);
            socket.send(payload);
        }
    }

    @bind
    public connect() {
        if (this.closed) return;
        this.teardownSocket();
        this.socket = new WebSocket(this.options.wsUrl, ['tty']);
        const { socket, register } = this;

        socket.binaryType = 'arraybuffer';
        this.socketDisposables.push(register(addEventListener(socket, 'open', this.onSocketOpen)));
        this.socketDisposables.push(register(addEventListener(socket, 'message', this.onSocketData as EventListener)));
        this.socketDisposables.push(register(addEventListener(socket, 'close', this.onSocketClose as EventListener)));
        this.socketDisposables.push(register(addEventListener(socket, 'error', () => (this.doReconnect = false))));
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');

        const { textEncoder, terminal, overlayAddon } = this;
        // The workspace owns the persisted session id; Xterm only keeps the
        // in-memory one. History replays use their own read-only id.
        const session = this.attachOnly ? this.requestedSession : this.sessionId;
        const msg = buildHandshake({
            token: this.token,
            columns: terminal.cols,
            rows: terminal.rows,
            session,
            sessionTimeout: this.sessionTimeout(),
            attachOnly: this.attachOnly,
            replayFrames: true,
        });
        this.socket?.send(textEncoder.encode(msg));

        if (this.attachOnly) {
            this.readOnly = true;
            terminal.reset();
            terminal.options.disableStdin = true;
            overlayAddon.showOverlay('Read-only history');
        } else {
            this.readOnly = false;
            terminal.reset();
            terminal.options.disableStdin = false;
            if (this.connectNotice) {
                overlayAddon.showOverlay(this.connectNotice, 300);
                this.connectNotice = undefined;
            } else if (this.opened) {
                overlayAddon.showOverlay('Reconnected', 300);
            }
        }
        this.opened = true;

        this.doReconnect = this.reconnect;
        this.initListeners();
        this.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

        const wasHistory = this.readOnly || this.attachOnly;
        const { refreshToken, connect, doReconnect, overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed');
        this.reset();

        // A history replay is a read-only snapshot: never reconnect and never
        // offer "Press Enter". This is handled before the 1008 session clearing
        // below, so a forbidden replay keeps the stored live session.
        if (wasHistory) {
            if (this.exitCode !== undefined) {
                const code = this.exitCode < 0 ? 'unknown' : String(this.exitCode);
                overlayAddon.showOverlay(`History ended · exit ${code}`);
            } else {
                overlayAddon.showOverlay('Session not found');
            }
            this.options.onHistoryChange?.(undefined);
            return;
        }

        // 1008: CLOSE_POLICY. The stored session cannot be used by this user.
        if (event.code === 1008) {
            this.setLive(undefined);
        }

        // A socket that never opened was refused during the HTTP upgrade, for
        // example -o / -m returning 403. Do not spin on reconnects and do not
        // close the tab; leave a manual retry available.
        const refused = !this.opened;
        if (refused) {
            overlayAddon.showOverlay('Connection refused · server limit or offline');
            this.options.onConnectionFailed?.('Connection refused');
            this.focus();
        }

        const { terminal, register } = this;
        // 1000: CLOSE_NORMAL
        if (!refused && event.code !== 1000 && doReconnect) {
            overlayAddon.showOverlay('Reconnecting...');
            refreshToken().then(ok => {
                if (ok && !this.closed) connect();
            });
        } else if (!refused && this.closeOnDisconnect) {
            // Closing the whole browser tab would discard every other tab.
            this.options.onRequestClose?.();
        } else {
            const keyDispose = register(
                terminal.onKey(e => {
                    const event = e.domEvent;
                    if (event.key === 'Enter') {
                        keyDispose.dispose();
                        overlayAddon.showOverlay('Reconnecting...');
                        refreshToken().then(ok => {
                            if (ok && !this.closed) connect();
                        });
                    }
                })
            );
            overlayAddon.showOverlay(refused ? 'Press ⏎ to Retry' : 'Press ⏎ to Reconnect');
        }
    }

    @bind
    private parseOptsFromUrlQuery(query: string): Preferences {
        const parsed = parseQueryOptions(query, this.options.clientOptions, this.terminal.options);
        for (const [key, value] of Object.entries(parsed)) {
            if (
                this.options.clientOptions[key as keyof ClientOptions] === undefined &&
                this.terminal.options[key] === undefined
            ) {
                console.warn(`[ttyd] maybe unknown option: ${key}=${value}, treating as string`);
            }
        }
        return parsed as Preferences;
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { textDecoder } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        const data = rawData.slice(1);

        switch (cmd) {
            case Command.OUTPUT:
            case REPLAY_OUTPUT:
                // Replayed history is written verbatim: it was already shown
                // before the reconnect and must not re-trigger a `trz` upload.
                if (bypassesTransferFilter(cmd, this.readOnly)) {
                    this.writeData(new Uint8Array(data));
                } else {
                    this.writeFunc(data);
                }
                break;
            case Command.SET_WINDOW_TITLE:
                this.title = textDecoder.decode(data);
                this.setDocumentTitle(this.title);
                break;
            case Command.SET_PREFERENCES:
                this.applyPreferences({
                    ...this.options.clientOptions,
                    ...JSON.parse(textDecoder.decode(data)),
                    ...this.parseOptsFromUrlQuery(window.location.search),
                } as Preferences);
                break;
            case Command.SET_SESSION:
                // A replay connection never creates a PTY, so its id is not a
                // live session and must not be persisted.
                if (this.attachOnly) break;
                this.setLive(textDecoder.decode(data));
                break;
            case Command.READONLY:
                this.handleReadonlyFrame(new Uint8Array(data));
                break;
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private handleReadonlyFrame(bytes: Uint8Array) {
        const frame = parseReadonlyFrame(bytes);
        if (!frame) {
            console.warn('[ttyd] invalid read-only replay frame');
            return;
        }

        const { terminal, overlayAddon } = this;
        this.readOnly = true;
        this.exitCode = frame.exitCode;
        terminal.options.disableStdin = true;
        const command = this.historyCommand ?? 'History';
        this.setDocumentTitle(`${command} (ended)`);
        const code = frame.exitCode < 0 ? 'unknown' : String(frame.exitCode);
        overlayAddon.showOverlay(`Read-only · exit ${code}`);
    }

    @bind
    private applyPreferences(prefs: Preferences) {
        const { terminal, register } = this;
        if ((prefs.enableZmodem || prefs.enableTrzsz) && !this.zmodemAddon) {
            this.zmodemAddon = new ZmodemAddon({
                zmodem: prefs.enableZmodem,
                trzsz: prefs.enableTrzsz,
                windows: prefs.isWindows,
                trzszDragInitTimeout: prefs.trzszDragInitTimeout,
                maxDataChunkSize: MAX_TRZSZ_DATA_CHUNK,
                onSend: this.sendCb,
                sender: this.sendData,
                writer: this.writeData,
            });
            this.writeFunc = data => this.zmodemAddon?.consume(data);
            terminal.loadAddon(register(this.zmodemAddon));
        }

        for (const [key, value] of activePreferenceEntries(prefs)) {
            switch (key) {
                case 'rendererType':
                    this.setRendererType(value);
                    break;
                case 'disableLeaveAlert':
                    if (value) {
                        // The workspace owns the single beforeunload listener.
                        this.options.onLeaveAlertDisabled?.();
                        console.log('[ttyd] Leave site alert disabled');
                    }
                    break;
                case 'disableResizeOverlay':
                    if (value) {
                        console.log('[ttyd] Resize overlay disabled');
                        this.resizeOverlay = false;
                    }
                    break;
                case 'disableReconnect':
                    if (value) {
                        console.log('[ttyd] Reconnect disabled');
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'enableZmodem':
                    if (value) console.log('[ttyd] Zmodem enabled');
                    break;
                case 'enableTrzsz':
                    if (value) console.log('[ttyd] trzsz enabled');
                    break;
                case 'trzszDragInitTimeout':
                    if (value) console.log(`[ttyd] trzsz drag init timeout: ${value}`);
                    break;
                case 'enableSixel':
                    if (value) {
                        this.installSixel(terminal);
                        console.log('[ttyd] Sixel enabled');
                    }
                    break;
                case 'closeOnDisconnect':
                    if (value) {
                        console.log('[ttyd] close on disconnect enabled (Reconnect disabled)');
                        this.closeOnDisconnect = true;
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'titleFixed':
                    if (!value || value === '') break;
                    console.log(`[ttyd] setting fixed title: ${value}`);
                    this.titleFixed = value;
                    this.setDocumentTitle(value);
                    break;
                case 'isWindows':
                    if (value) console.log('[ttyd] is windows');
                    break;
                case 'unicodeVersion':
                    switch (value) {
                        case 6:
                        case '6':
                            console.log('[ttyd] setting Unicode version: 6');
                            break;
                        case 11:
                        case '11':
                        default:
                            console.log('[ttyd] setting Unicode version: 11');
                            terminal.loadAddon(new Unicode11Addon());
                            terminal.unicode.activeVersion = '11';
                            break;
                    }
                    break;
                default:
                    console.log(`[ttyd] option: ${key}=${JSON.stringify(value)}`);
                    if (terminal.options[key] instanceof Object) {
                        terminal.options[key] = Object.assign({}, terminal.options[key], value);
                    } else {
                        terminal.options[key] = value;
                    }
                    if (key.indexOf('font') === 0) this.fit();
                    break;
            }
        }
    }

    @bind
    private installSixel(terminal: Terminal) {
        if (this.sixelInstalled) return;
        this.sixelInstalled = true;
        terminal.loadAddon(this.register(new ImageAddon()));
        // Primary DA only. `CSI > c` (secondary DA) keeps xterm.js's own reply.
        this.register(
            terminal.parser.registerCsiHandler({ final: 'c' }, params => {
                const reply = sixelPrimaryDeviceAttributes(params);
                if (!reply) return false;
                terminal.input(reply, false);
                return true;
            })
        );
    }

    @bind
    private setRendererType(value: RendererType) {
        const { terminal } = this;
        const disposeWebglRenderer = () => {
            try {
                this.webglAddon?.dispose();
            } catch {
                // ignore
            }
            this.webglAddon = undefined;
        };
        const enableDomRenderer = () => {
            disposeWebglRenderer();
            console.log('[ttyd] dom renderer loaded');
        };
        const enableWebglRenderer = () => {
            if (this.webglAddon) return;
            this.webglAddon = new WebglAddon();
            try {
                this.webglAddon.onContextLoss(() => {
                    this.webglAddon?.dispose();
                });
                terminal.loadAddon(this.webglAddon);
                console.log('[ttyd] WebGL renderer loaded');
            } catch (e) {
                console.log('[ttyd] WebGL renderer could not be loaded, falling back to dom renderer', e);
                disposeWebglRenderer();
            }
        };

        switch (value) {
            case 'webgl':
                enableWebglRenderer();
                break;
            case 'canvas':
                // The canvas addon was removed in xterm.js 6, use the DOM renderer instead.
                console.warn('[ttyd] canvas renderer is no longer supported, falling back to dom renderer');
                enableDomRenderer();
                break;
            case 'dom':
                enableDomRenderer();
                break;
            default:
                break;
        }
    }
}
