import { bind } from 'decko';
import { Component, h } from 'preact';

import './login.scss';

interface Props {
    loginUrl: string;
    onSuccess: () => void;
}

interface State {
    username: string;
    password: string;
    remember: boolean;
    submitting: boolean;
    error: string;
}

export class Login extends Component<Props, State> {
    state: State = {
        username: '',
        password: '',
        remember: true,
        submitting: false,
        error: '',
    };

    @bind
    private submit(event: Event) {
        event.preventDefault();
        if (this.state.submitting) return;

        this.setState({ submitting: true, error: '' });
        void this.signIn();
    }

    private async signIn() {
        try {
            const response = await fetch(this.props.loginUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
                body: JSON.stringify({
                    username: this.state.username,
                    password: this.state.password,
                    remember: this.state.remember,
                }),
            });
            if (response.ok) {
                this.props.onSuccess();
                return;
            }
            this.setState({
                submitting: false,
                error: response.status === 401 ? 'Invalid username or password.' : 'Sign in failed. Try again.',
            });
        } catch (error) {
            console.error('[ttyd] login failed:', error);
            this.setState({
                submitting: false,
                error: 'ttyd is not responding. Try again.',
            });
        }
    }

    @bind
    private setUsername(event: Event) {
        this.setState({ username: (event.currentTarget as HTMLInputElement).value });
    }

    @bind
    private setPassword(event: Event) {
        this.setState({ password: (event.currentTarget as HTMLInputElement).value });
    }

    @bind
    private setRemember(event: Event) {
        this.setState({ remember: (event.currentTarget as HTMLInputElement).checked });
    }

    render() {
        const { username, password, remember, submitting, error } = this.state;

        return (
            <main class="login-page">
                <section class="login-card" aria-labelledby="login-title">
                    <div class="login-eyebrow">
                        <span class="login-status-dot" aria-hidden="true" />
                        AUTH REQUIRED
                    </div>
                    <h1 class="login-title" id="login-title">
                        ttyd
                        <span class="login-cursor" aria-hidden="true" />
                    </h1>
                    <p class="login-copy">Sign in to open a terminal session.</p>

                    <form onSubmit={this.submit} aria-busy={submitting}>
                        <label class="login-field">
                            <span class="login-label">Username</span>
                            <input
                                class="login-input"
                                type="text"
                                name="username"
                                value={username}
                                onInput={this.setUsername}
                                autoComplete="username"
                                autoCapitalize="none"
                                spellcheck={false}
                                autoFocus
                                disabled={submitting}
                            />
                        </label>

                        <label class="login-field">
                            <span class="login-label">Password</span>
                            <input
                                class="login-input"
                                type="password"
                                name="password"
                                value={password}
                                onInput={this.setPassword}
                                autoComplete="current-password"
                                spellcheck={false}
                                disabled={submitting}
                            />
                        </label>

                        <label class="login-remember">
                            <input
                                type="checkbox"
                                checked={remember}
                                onChange={this.setRemember}
                                disabled={submitting}
                            />
                            <span>
                                <strong>Keep me signed in</strong>
                                <small>Stay signed in on this browser for 30 days.</small>
                            </span>
                        </label>

                        {error && (
                            <p class="login-error" role="alert">
                                {error}
                            </p>
                        )}

                        <button class="login-submit" type="submit" disabled={submitting}>
                            {submitting ? 'Signing in…' : 'Sign in'}
                        </button>
                    </form>

                    <p class="login-foot">
                        <span>ttyd web terminal</span>
                        <span aria-hidden="true">● terminal session</span>
                    </p>
                </section>
            </main>
        );
    }
}
