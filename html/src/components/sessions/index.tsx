import { bind } from 'decko';
import { Component, h } from 'preact';

import {
    formatEndedAt,
    formatExitCode,
    parseSessionsResponse,
    runningSessions,
    shortId,
    type SessionSummary,
    type SessionsResponse,
} from './sessions';

import './sessions.css';

const POLL_INTERVAL = 5000;

export interface SessionPanelProps {
    sessionsUrl: string;
    currentSessionId?: string;
    viewingHistoryId?: string;
    onAuthRequired?: () => void;
    onAttach?: (session: SessionSummary) => void;
    onReplay?: (session: SessionSummary) => void;
    onNewSession?: () => void;
}

interface State {
    /// The server answered 200, so the panel can be shown at all.
    enabled: boolean;
    open: boolean;
    loading: boolean;
    error: string;
    data?: SessionsResponse;
    deleting?: string;
}

type SessionsResult = SessionsResponse | 'unsupported' | 'auth-required';

export class SessionPanel extends Component<SessionPanelProps, State> {
    state: State = {
        enabled: false,
        open: false,
        loading: false,
        error: '',
    };

    private mounted = false;
    private timer?: number;

    componentDidMount() {
        this.mounted = true;
        void this.probe();
    }

    componentWillUnmount() {
        this.mounted = false;
        this.stopPolling();
    }

    private async requestSessions(): Promise<SessionsResult> {
        const response = await fetch(this.props.sessionsUrl, {
            cache: 'no-store',
            credentials: 'same-origin',
        });
        if (response.status === 401) {
            this.props.onAuthRequired?.();
            return 'auth-required';
        }
        // No auth configured on the server: there is no owner to list.
        if (response.status === 404) return 'unsupported';
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = parseSessionsResponse(await response.json());
        if (!data) throw new Error('invalid sessions response');
        return data;
    }

    private async probe() {
        if (!this.props.sessionsUrl) return;
        try {
            const result = await this.requestSessions();
            if (!this.mounted || result === 'auth-required') return;
            if (result === 'unsupported') {
                this.setState({ enabled: false });
                return;
            }
            this.setState({ enabled: true, data: result });
        } catch (error) {
            if (!this.mounted) return;
            console.warn(`[ttyd] sessions unavailable: ${this.props.sessionsUrl}`, error);
            this.setState({ enabled: false });
        }
    }

    private async load(silent = false) {
        if (!this.mounted) return;
        if (!silent) this.setState({ loading: true, error: '' });

        try {
            const result = await this.requestSessions();
            if (!this.mounted || result === 'auth-required') return;
            if (result === 'unsupported') {
                this.stopPolling();
                this.setState({ enabled: false, open: false, loading: false, data: undefined });
                return;
            }
            this.setState({ enabled: true, data: result, loading: false, error: '' });
        } catch (error) {
            if (!this.mounted) return;
            console.error(`[ttyd] fetch ${this.props.sessionsUrl}: `, error);
            this.setState({ loading: false, error: 'Unable to load sessions.' });
        }
    }

    private startPolling() {
        if (this.timer !== undefined) return;
        this.timer = window.setInterval(() => void this.load(true), POLL_INTERVAL);
    }

    private stopPolling() {
        if (this.timer === undefined) return;
        window.clearInterval(this.timer);
        this.timer = undefined;
    }

    @bind
    private toggle() {
        if (this.state.open) {
            this.close();
            return;
        }
        this.setState({ open: true, error: '' });
        void this.load();
        this.startPolling();
    }

    @bind
    private close() {
        this.stopPolling();
        if (this.state.open) this.setState({ open: false });
    }

    @bind
    private handleAttach(session: SessionSummary) {
        this.close();
        this.props.onAttach?.(session);
    }

    @bind
    private handleReplay(session: SessionSummary) {
        this.close();
        this.props.onReplay?.(session);
    }

    @bind
    private handleNewSession() {
        this.close();
        this.props.onNewSession?.();
    }

    @bind
    private handleDelete(event: Event, id: string) {
        event.stopPropagation();
        void this.deleteSession(id);
    }

    private async deleteSession(id: string) {
        if (this.state.deleting) return;
        this.setState({ deleting: id, error: '' });

        try {
            const response = await fetch(`${this.props.sessionsUrl}/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (!this.mounted) return;

            if (response.status === 204 || response.status === 404) {
                this.setState(({ data, ...state }) => ({
                    ...state,
                    deleting: undefined,
                    data: data && {
                        sessions: data.sessions.filter(session => session.id !== id),
                        history: data.history.filter(session => session.id !== id),
                    },
                }));
                void this.load(true);
                return;
            }

            this.setState({
                deleting: undefined,
                error:
                    response.status === 403
                        ? 'You can only delete your own sessions.'
                        : `Unable to delete session (HTTP ${response.status}).`,
            });
        } catch (error) {
            if (!this.mounted) return;
            console.error(`[ttyd] delete ${this.props.sessionsUrl}/${id}: `, error);
            this.setState({ deleting: undefined, error: 'Unable to delete session.' });
        }
    }

    render(_: SessionPanelProps, { enabled, open, loading, error, data, deleting }: State) {
        if (!enabled) return null;

        const running = runningSessions(data, this.props.currentSessionId);
        const history = data?.history ?? [];
        const empty = running.length === 0 && history.length === 0;

        return (
            <div class="session-panel">
                <button
                    class="session-toggle"
                    type="button"
                    aria-label={open ? 'Hide sessions' : 'Show sessions'}
                    aria-expanded={open}
                    onClick={this.toggle}
                >
                    Sessions
                </button>

                {open && (
                    <aside class="session-drawer" aria-label="Sessions">
                        <header class="session-header">
                            <h2 class="session-title">Sessions</h2>
                            <div class="session-actions">
                                <button class="session-new" type="button" onClick={this.handleNewSession}>
                                    New session
                                </button>
                                <button
                                    class="session-close"
                                    type="button"
                                    aria-label="Close sessions"
                                    onClick={this.close}
                                >
                                    ×
                                </button>
                            </div>
                        </header>

                        <div class="session-body">
                            {error && (
                                <p class="session-error" role="alert">
                                    {error}
                                </p>
                            )}
                            {loading && !data && <p class="session-note">Loading sessions…</p>}
                            {empty && !loading && <p class="session-note">No sessions yet.</p>}

                            {running.length > 0 && (
                                <section class="session-group">
                                    <h3 class="session-group-title">Running</h3>
                                    <ul class="session-list">
                                        {running.map(session => (
                                            <li class="session-item" key={session.id}>
                                                <button
                                                    class="session-row"
                                                    type="button"
                                                    onClick={() => this.handleAttach(session)}
                                                >
                                                    <span class="session-row-main">{session.command}</span>
                                                    <span class="session-row-meta">
                                                        <span class="session-id">{shortId(session.id)}</span>
                                                        {session.owner && (
                                                            <span class="session-owner">{session.owner}</span>
                                                        )}
                                                        <span class="session-attached">
                                                            {session.attached ?? 0} attached
                                                        </span>
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}

                            {history.length > 0 && (
                                <section class="session-group">
                                    <h3 class="session-group-title">History</h3>
                                    <ul class="session-list">
                                        {history.map(session => (
                                            <li class="session-item" key={session.id}>
                                                <button
                                                    class={`session-row${
                                                        session.id === this.props.viewingHistoryId
                                                            ? ' session-row--active'
                                                            : ''
                                                    }`}
                                                    type="button"
                                                    onClick={() => this.handleReplay(session)}
                                                >
                                                    <span class="session-row-main">{session.command}</span>
                                                    <span class="session-row-meta">
                                                        <span class="session-ended">
                                                            {formatEndedAt(session.endedAt)}
                                                        </span>
                                                        <span class="session-exit">
                                                            {formatExitCode(session.exitCode)}
                                                        </span>
                                                    </span>
                                                </button>
                                                <button
                                                    class="session-delete"
                                                    type="button"
                                                    aria-label={`Delete ${session.command}`}
                                                    disabled={deleting === session.id}
                                                    onClick={event => this.handleDelete(event, session.id)}
                                                >
                                                    ×
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                        </div>
                    </aside>
                )}
            </div>
        );
    }
}
