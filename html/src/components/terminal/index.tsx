import { bind } from 'decko';
import { Component, h } from 'preact';
import type { ITerminalOptions } from '@xterm/xterm';
import { Xterm, type ClientOptions, type FlowControl } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';

/** Commands the workspace needs for a mounted tab. */
export interface TerminalHandle {
    setActive(active: boolean): void;
    fit(): void;
    focus(): void;
    hasLiveSession(): boolean;
    dispose(): void;
}

export interface TerminalProps {
    wsUrl: string;
    tokenUrl: string;
    sessionsUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
    sessionTimeout: number;
    tabId: string;
    active: boolean;
    /** Only read when the terminal is constructed. */
    initialSessionId?: string;
    /** Start a read-only replay right after open(); only read once. */
    initialHistory?: { id: string; command: string };
    onAuthRequired?: () => void;
    onHistoryChange?: (tabId: string, id: string | undefined) => void;
    onLiveSessionIdChange?: (tabId: string, id: string | undefined) => void;
    onTitleChange?: (tabId: string, title: string | undefined) => void;
    onReady?: (tabId: string, handle: TerminalHandle | null) => void;
    onRequestActivate?: (tabId: string) => void;
    onRequestClose?: (tabId: string) => void;
    onLeaveAlertDisabled?: () => void;
    onConnectionFailed?: (tabId: string, message: string) => void;
}

interface State {
    modal: boolean;
}

export class Terminal extends Component<TerminalProps, State> {
    private container: HTMLElement;
    private xterm: Xterm;
    private unmounted = false;

    state: State = {
        modal: false,
    };

    /** A stable handle, independent of Preact key reordering. */
    private handle: TerminalHandle = {
        setActive: active => this.xterm.setActive(active),
        fit: () => this.xterm.fit(),
        focus: () => this.xterm.focus(),
        hasLiveSession: () => this.xterm.hasLiveSession(),
        dispose: () => this.xterm.dispose(),
    };

    constructor(props: TerminalProps) {
        super(props);
        // Read props dynamically in every callback: Preact may reuse this
        // instance with newer props, but the Xterm is created only once.
        this.xterm = new Xterm(
            {
                wsUrl: props.wsUrl,
                tokenUrl: props.tokenUrl,
                sessionsUrl: props.sessionsUrl,
                flowControl: props.flowControl,
                clientOptions: props.clientOptions,
                termOptions: props.termOptions,
                sessionTimeout: props.sessionTimeout,
                initialSessionId: props.initialSessionId,
                active: props.active,
                onAuthRequired: () => this.props.onAuthRequired?.(),
                onHistoryChange: id => this.props.onHistoryChange?.(this.props.tabId, id),
                onLiveSessionIdChange: id => this.props.onLiveSessionIdChange?.(this.props.tabId, id),
                onTitleChange: title => this.props.onTitleChange?.(this.props.tabId, title),
                onLeaveAlertDisabled: () => this.props.onLeaveAlertDisabled?.(),
                onRequestClose: () => this.props.onRequestClose?.(this.props.tabId),
                onConnectionFailed: message => this.props.onConnectionFailed?.(this.props.tabId, message),
            },
            this.showModal
        );
    }

    async componentDidMount() {
        this.props.onReady?.(this.props.tabId, this.handle);
        if (!(await this.xterm.refreshToken())) return;
        if (this.unmounted) return;
        this.xterm.open(this.container);
        const history = this.props.initialHistory;
        if (history) {
            this.xterm.startReplay(history.id, history.command);
        } else {
            this.xterm.connect();
        }
    }

    componentDidUpdate(previous: TerminalProps) {
        if (previous.active !== this.props.active) {
            this.xterm.setActive(this.props.active);
        }
    }

    componentWillUnmount() {
        this.unmounted = true;
        this.props.onReady?.(this.props.tabId, null);
        this.xterm.dispose();
    }

    render(_props: TerminalProps, { modal }: State) {
        return (
            <div
                class="terminal-container"
                ref={c => {
                    this.container = c as HTMLElement;
                }}
            >
                <Modal show={modal} onCancel={this.cancelSend}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
            </div>
        );
    }

    @bind
    showModal() {
        // A modal inside a hidden pane would be invisible to the user.
        if (!this.props.active) this.props.onRequestActivate?.(this.props.tabId);
        this.setState({ modal: true });
    }

    @bind
    cancelSend() {
        this.setState({ modal: false });
        this.xterm.cancelSend();
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
