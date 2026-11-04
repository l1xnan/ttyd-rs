import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';
import { SessionPanel } from '../sessions';
import type { SessionSummary } from '../sessions/sessions';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
    currentSessionId?: string;
    viewingHistoryId?: string;
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;

    state: State = {
        modal: false,
    };

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(
            {
                ...props,
                onSessionChange: this.handleSessionChange,
                onHistoryChange: this.handleHistoryChange,
            },
            this.showModal
        );
    }

    async componentDidMount() {
        if (!(await this.xterm.refreshToken())) return;
        this.xterm.open(this.container);
        this.xterm.connect();
    }

    componentWillUnmount() {
        this.xterm.close();
    }

    render({ id, sessionsUrl, onAuthRequired }: Props, { modal, currentSessionId, viewingHistoryId }: State) {
        return (
            <div
                id={id}
                ref={c => {
                    this.container = c as HTMLElement;
                }}
            >
                <SessionPanel
                    sessionsUrl={sessionsUrl}
                    currentSessionId={currentSessionId}
                    viewingHistoryId={viewingHistoryId}
                    onAuthRequired={onAuthRequired}
                    onAttach={this.attachSession}
                    onReplay={this.replaySession}
                    onNewSession={this.newSession}
                />
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

    @bind
    private handleSessionChange(id: string | undefined) {
        if (id === this.state.currentSessionId) return;
        this.setState({ currentSessionId: id });
    }

    @bind
    private handleHistoryChange(id: string | undefined) {
        if (id === this.state.viewingHistoryId) return;
        this.setState({ viewingHistoryId: id });
    }

    @bind
    private attachSession(session: SessionSummary) {
        this.xterm.attachSession(session.id);
    }

    @bind
    private replaySession(session: SessionSummary) {
        this.xterm.replayHistory(session.id, session.command);
    }

    @bind
    private newSession() {
        this.xterm.newSession();
    }
}
