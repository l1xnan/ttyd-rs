import { bind } from 'decko';
import { Component, h } from 'preact';
import { Modal } from '../modal';
import {
    downloadFile,
    downloadPathUrl,
    filesUrl,
    formatSize,
    HttpTransferError,
    pickFiles,
    uploadFile,
    uploadUrl,
} from './api';

import './transfer.css';

export type TransferMode = 'upload' | 'download';

export interface TransferPanelProps {
    open: boolean;
    mode: TransferMode;
    sessionsUrl: string;
    sessionId?: string;
    droppedFiles?: File[];
    maxUpload: number;
    /** Configured fallback destination, reported by `/token`. */
    transferDir?: string | null;
    followCwd: boolean;
    onClose: () => void;
}

interface TransferPanelState {
    progress?: { name: string; loaded: number; total: number };
    error: string;
    notice: string;
    downloadPath: string;
}

function describeError(error: unknown): string {
    if (error instanceof HttpTransferError) return `${error.message} (HTTP ${error.status})`;
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * Two deliberately small dialogs: upload (files go to the current/default
 * directory) and download (type a server path, press Download).
 */
export class TransferPanel extends Component<TransferPanelProps, TransferPanelState> {
    state: TransferPanelState = { error: '', notice: '', downloadPath: '' };

    componentDidMount() {
        if (this.props.open) void this.onOpen();
    }

    componentDidUpdate(previous: TransferPanelProps) {
        if (!this.props.open) return;
        const reopened = !previous.open;
        const changed = previous.mode !== this.props.mode || previous.sessionId !== this.props.sessionId;
        if (reopened || changed) void this.onOpen();
    }

    private baseUrl(): string | undefined {
        const { sessionsUrl, sessionId } = this.props;
        return sessionId ? filesUrl(sessionsUrl, sessionId) : undefined;
    }

    private destinationText(): string {
        const { transferDir, followCwd } = this.props;
        if (followCwd) {
            return transferDir
                ? `Shell current directory; falls back to ${transferDir} when unavailable`
                : 'Shell current directory; falls back to the server working directory when unavailable';
        }
        return transferDir ?? 'Server working directory (-w / process cwd)';
    }

    private async onOpen() {
        this.setState({ error: '', notice: '' });
        if (this.props.mode !== 'upload') return;
        const files = this.props.droppedFiles?.length ? this.props.droppedFiles : await pickFiles();
        if (files?.length) await this.upload(files);
    }

    @bind
    private async choose() {
        const files = await pickFiles();
        if (files?.length) await this.upload(files);
    }

    private async upload(files: File[]) {
        const base = this.baseUrl();
        if (!base) return;
        for (const file of files) {
            if (this.props.maxUpload > 0 && file.size > this.props.maxUpload) {
                this.setState({
                    error: `${file.name} exceeds the server limit (${formatSize(this.props.maxUpload)})`,
                });
                return;
            }
            this.setState({
                progress: { name: file.name, loaded: 0, total: file.size },
                error: '',
                notice: '',
            });
            try {
                const result = await uploadFile(uploadUrl(base, file.name), file, (loaded, total) =>
                    this.setState({ progress: { name: file.name, loaded, total } })
                );
                this.setState({
                    notice: `Uploaded to ${result.path}`,
                    progress: undefined,
                });
            } catch (error) {
                this.setState({ error: describeError(error), progress: undefined });
                return;
            }
        }
    }

    @bind
    private async download() {
        const { sessionsUrl, sessionId } = this.props;
        const path = this.state.downloadPath.trim();
        if (!sessionId || !path) return;
        const name = path.split(/[\\/]/).pop() || 'download';
        this.setState({ error: '', notice: '' });
        try {
            await downloadFile(downloadPathUrl(sessionsUrl, sessionId, path), name);
            this.setState({ notice: `Downloaded ${name}` });
        } catch (error) {
            this.setState({ error: describeError(error) });
        }
    }

    @bind
    private onPathInput(event: Event) {
        this.setState({ downloadPath: (event.target as HTMLInputElement).value });
    }

    @bind
    private onPathKeyDown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            void this.download();
        }
    }

    render(props: TransferPanelProps, state: TransferPanelState) {
        const uploading = props.mode === 'upload';
        return (
            <Modal show={props.open} onCancel={props.onClose} variant="dark">
                <div class="transfer-panel">
                    <h2 class="transfer-title">{uploading ? 'Upload files' : 'Download file'}</h2>
                    {uploading ? (
                        <div class="transfer-section">
                            <div class="transfer-location">
                                <span class="transfer-label">Destination</span>
                                <code class="transfer-cwd">{this.destinationText()}</code>
                            </div>
                            <p class="transfer-hint">
                                Choose files, or drop them onto the terminal. Uploads always land in the destination
                                above.
                            </p>
                            <div class="transfer-actions">
                                <button
                                    class="transfer-button"
                                    type="button"
                                    disabled={!props.sessionId}
                                    onClick={this.choose}
                                >
                                    Upload files…
                                </button>
                            </div>
                            {state.progress && (
                                <div class="transfer-progress">
                                    <span>
                                        {state.progress.name} · {formatSize(state.progress.loaded)} /{' '}
                                        {formatSize(state.progress.total)}
                                    </span>
                                    <progress max={Math.max(state.progress.total, 1)} value={state.progress.loaded} />
                                </div>
                            )}
                        </div>
                    ) : (
                        <div class="transfer-section">
                            <div class="transfer-location">
                                <span class="transfer-label">Server path</span>
                                <input
                                    class="transfer-input"
                                    type="text"
                                    value={state.downloadPath}
                                    placeholder="/absolute/path, or relative to the destination"
                                    aria-label="Server file path"
                                    onInput={this.onPathInput}
                                    onKeyDown={this.onPathKeyDown}
                                />
                            </div>
                            <p class="transfer-hint">
                                Enter an absolute path, or a path relative to the upload destination.
                            </p>
                            <div class="transfer-actions">
                                <button
                                    class="transfer-button"
                                    type="button"
                                    disabled={!props.sessionId || !state.downloadPath.trim()}
                                    onClick={() => void this.download()}
                                >
                                    Download
                                </button>
                            </div>
                        </div>
                    )}
                    {state.error && (
                        <div class="transfer-error" role="alert">
                            {state.error}
                        </div>
                    )}
                    {state.notice && <div class="transfer-notice">{state.notice}</div>}
                </div>
            </Modal>
        );
    }
}
