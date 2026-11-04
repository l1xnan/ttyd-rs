import { bind } from 'decko';
import { Component, Fragment, h } from 'preact';

import { Login } from './login';
import { Terminal } from './terminal';

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import { DEFAULT_CLIENT_OPTIONS, type ClientOptions, type FlowControl } from './terminal/xterm';

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const path = window.location.pathname.replace(/[/]+$/, '');
const wsUrl = [protocol, '//', window.location.host, path, '/ws', window.location.search].join('');
const tokenUrl = [window.location.protocol, '//', window.location.host, path, '/token'].join('');
const sessionsUrl = [window.location.protocol, '//', window.location.host, path, '/sessions'].join('');
const loginUrl = [window.location.protocol, '//', window.location.host, path, '/login'].join('');
const logoutUrl = [window.location.protocol, '//', window.location.host, path, '/logout'].join('');
const clientOptions: ClientOptions = { ...DEFAULT_CLIENT_OPTIONS };
const termOptions = {
    fontSize: 13,
    fontFamily: 'Consolas,Liberation Mono,Menlo,Courier,monospace',
    theme: {
        foreground: '#d2d2d2',
        background: '#2b2b2b',
        cursor: '#adadad',
        black: '#000000',
        red: '#d81e00',
        green: '#5ea702',
        yellow: '#cfae00',
        blue: '#427ab3',
        magenta: '#89658e',
        cyan: '#00a7aa',
        white: '#dbded8',
        brightBlack: '#686a66',
        brightRed: '#f54235',
        brightGreen: '#99e343',
        brightYellow: '#fdeb61',
        brightBlue: '#84b0d8',
        brightMagenta: '#bc94b7',
        brightCyan: '#37e6e8',
        brightWhite: '#f1f1f0',
    } as ITheme,
    allowProposedApi: true,
} as ITerminalOptions;
const flowControl = {
    limit: 100000,
    highWater: 10,
    lowWater: 4,
} as FlowControl;

interface TokenResponse {
    token: string;
    login?: boolean;
    sessionTimeout?: number;
}

type Status = 'checking' | 'login' | 'terminal' | 'error';

interface State {
    status: Status;
    loginEnabled: boolean;
    error: string;
    loggingOut: boolean;
    sessionTimeout: number;
}

export class App extends Component<{}, State> {
    state: State = {
        status: 'checking',
        loginEnabled: false,
        error: '',
        loggingOut: false,
        sessionTimeout: 0,
    };

    componentDidMount() {
        void this.checkSession();
    }

    @bind
    private async checkSession() {
        this.setState({ status: 'checking', error: '' });

        try {
            const response = await fetch(tokenUrl, {
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (response.status === 401) {
                this.setState({ status: 'login', loginEnabled: true, error: '' });
                return;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = (await response.json()) as TokenResponse;
            if (typeof data.token !== 'string') {
                throw new Error('invalid token response');
            }
            this.setState({
                status: 'terminal',
                loginEnabled: data.login === true,
                error: '',
                sessionTimeout:
                    typeof data.sessionTimeout === 'number' && data.sessionTimeout >= 0
                        ? Math.min(Math.trunc(data.sessionTimeout), 3600)
                        : 0,
            });
        } catch (error) {
            console.error(`[ttyd] fetch ${tokenUrl}: `, error);
            this.setState({
                status: 'error',
                error: 'ttyd is not responding. Check the server and try again.',
            });
        }
    }

    @bind
    private handleAuthRequired() {
        this.setState({
            status: 'login',
            loginEnabled: true,
            loggingOut: false,
            error: '',
        });
    }

    @bind
    private async handleLogout() {
        if (this.state.loggingOut) return;
        this.setState({ loggingOut: true, error: '' });

        try {
            const response = await fetch(logoutUrl, {
                method: 'POST',
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (!response.ok && response.status !== 401) {
                throw new Error(`HTTP ${response.status}`);
            }
            this.setState({
                status: 'login',
                loginEnabled: true,
                loggingOut: false,
                error: '',
            });
        } catch (error) {
            console.error(`[ttyd] fetch ${logoutUrl}: `, error);
            this.setState({
                loggingOut: false,
                error: 'Unable to sign out. Try again.',
            });
        }
    }

    render(_: {}, { status, loginEnabled, error, loggingOut, sessionTimeout }: State) {
        if (status === 'checking') {
            return (
                <main class="login-page">
                    <section class="login-card login-card--status" role="status" aria-live="polite">
                        <div class="login-eyebrow">
                            <span class="login-status-dot" aria-hidden="true" />
                            CONNECTING
                        </div>
                        <h1 class="login-title">
                            ttyd
                            <span class="login-cursor" aria-hidden="true" />
                        </h1>
                        <p class="login-copy">Checking session and preparing the terminal.</p>
                        <div class="login-loading">Connecting…</div>
                    </section>
                </main>
            );
        }

        if (status === 'login') {
            return <Login loginUrl={loginUrl} onSuccess={this.checkSession} />;
        }

        if (status === 'error') {
            return (
                <main class="login-page">
                    <section class="login-card login-card--status" role="alert">
                        <div class="login-eyebrow login-eyebrow--error">CONNECTION FAILED</div>
                        <h1 class="login-title">ttyd</h1>
                        <p class="login-copy">{error}</p>
                        <button class="login-submit" type="button" onClick={this.checkSession}>
                            Try again
                        </button>
                    </section>
                </main>
            );
        }

        return (
            <Fragment>
                <Terminal
                    id="terminal-container"
                    wsUrl={wsUrl}
                    tokenUrl={tokenUrl}
                    sessionsUrl={sessionsUrl}
                    clientOptions={clientOptions}
                    termOptions={termOptions}
                    flowControl={flowControl}
                    sessionTimeout={sessionTimeout}
                    onAuthRequired={this.handleAuthRequired}
                />
                {loginEnabled && (
                    <button class="logout-button" type="button" onClick={this.handleLogout} disabled={loggingOut}>
                        {loggingOut ? 'Signing out…' : 'Sign out'}
                    </button>
                )}
                {error && (
                    <div class="logout-error" role="alert">
                        {error}
                    </div>
                )}
            </Fragment>
        );
    }
}
