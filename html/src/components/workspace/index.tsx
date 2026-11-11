import { bind } from 'decko';
import { Component, h } from 'preact';
import type { ITerminalOptions } from '@xterm/xterm';
import { Terminal, type TerminalHandle } from '../terminal';
import { TransferPanel, type TransferMode } from '../transfer';
import { SessionPanel, type DeletedSessionKind } from '../sessions';
import type { SessionSummary } from '../sessions/sessions';
import type { ClientOptions, FlowControl } from '../terminal/xterm';
import { resolveSessionTimeout } from '../terminal/xterm/prefs';
import {
    activateTab,
    addTab,
    attachedSessionIds,
    closeTab,
    defaultMakeId,
    initialWorkspace,
    replayHistoryIds,
    resolveTabTitle,
    sessionHolders,
    setTabConnectionError,
    setTabSessionId,
    setTabTitle,
    setTabViewingHistory,
    type TabState,
    type WorkspaceState,
} from './tabs';
import { readWorkspace, workspaceStorageKey, writeWorkspace } from './storage';

import './workspace.css';

const SAVE_DELAY = 400;
const LEAVE_ALERT_MESSAGE = 'Close terminal? this will also terminate the command.';

export interface WorkspaceProps {
    wsUrl: string;
    tokenUrl: string;
    sessionsUrl: string;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
    flowControl: FlowControl;
    sessionTimeout: number;
    /** Authoritative server switch from `/token`. */
    transferEnabled: boolean;
    transferMaxUpload: number;
    transferDir?: string | null;
    transferFollowCwd?: boolean;
    loginEnabled: boolean;
    loggingOut: boolean;
    error: string;
    onAuthRequired: () => void;
    onLogout: () => void;
}

export class Workspace extends Component<WorkspaceProps, WorkspaceState> {
    /** Authoritative state; Preact's `this.state` can lag behind a batch. */
    private workspace: WorkspaceState;
    private handles = new Map<string, TerminalHandle>();
    private transfer: {
        open: boolean;
        mode: TransferMode;
        tabId?: string;
        droppedFiles?: File[];
    } = { open: false, mode: 'upload' };
    private storageKey = workspaceStorageKey(window.location.pathname);
    private storageAvailable = true;
    private saveTimer?: number;
    private leaveAlertDisabled = false;

    state: WorkspaceState;

    constructor(props: WorkspaceProps) {
        super(props);
        this.workspace = this.readInitial();
        this.state = this.workspace;
    }

    private readInitial(): WorkspaceState {
        try {
            return readWorkspace(window.sessionStorage, this.storageKey, defaultMakeId);
        } catch {
            return initialWorkspace(defaultMakeId);
        }
    }

    componentDidMount() {
        window.addEventListener('resize', this.onResize);
        window.addEventListener('beforeunload', this.onWindowUnload);
        window.addEventListener('pagehide', this.onPageHide);
        // Persist immediately: this migrates a legacy bare session id and
        // normalizes any malformed stored value.
        this.saveNow();
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('beforeunload', this.onWindowUnload);
        window.removeEventListener('pagehide', this.onPageHide);
        this.flush();
    }

    private apply(next: WorkspaceState, debounce = false) {
        if (next === this.workspace) return;
        this.workspace = next;
        this.setState(next);
        if (debounce) {
            this.scheduleSave();
        } else {
            this.saveNow();
        }
    }

    private scheduleSave() {
        if (!this.storageAvailable) return;
        if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => this.flush(), SAVE_DELAY);
    }

    private saveNow() {
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        if (!this.storageAvailable) return;
        try {
            this.storageAvailable = writeWorkspace(window.sessionStorage, this.storageKey, this.workspace);
        } catch {
            this.storageAvailable = false;
        }
    }

    private flush() {
        this.saveNow();
    }

    @bind
    private onResize() {
        // Fit only the visible tab; hidden panes keep their last known size.
        this.handles.get(this.workspace.activeId)?.fit();
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent) {
        if (this.leaveAlertDisabled) return undefined;
        if (resolveSessionTimeout(this.props.sessionTimeout, window.location.search) > 0) return undefined;
        if (![...this.handles.values()].some(handle => handle.hasLiveSession())) return undefined;

        event.preventDefault();
        event.returnValue = LEAVE_ALERT_MESSAGE;
        return LEAVE_ALERT_MESSAGE;
    }

    @bind
    private onPageHide() {
        this.flush();
    }

    @bind
    private onReady(tabId: string, handle: TerminalHandle | null) {
        if (handle) this.handles.set(tabId, handle);
        else this.handles.delete(tabId);
    }

    @bind
    private addEmptyTab() {
        this.apply(addTab(this.workspace, defaultMakeId));
    }

    @bind
    private addTerminalTab(session: SessionSummary) {
        this.apply(addTab(this.workspace, defaultMakeId, { sessionId: session.id, title: session.command }));
    }

    @bind
    private addReplayTab(session: SessionSummary) {
        this.apply(
            addTab(this.workspace, defaultMakeId, {
                history: {
                    id: session.id,
                    command: session.command,
                    returnToTabId: this.workspace.activeId,
                },
            })
        );
    }

    @bind
    private activate(tabId: string) {
        this.apply(activateTab(this.workspace, tabId));
    }

    /**
     * Closing a terminal tab ends its PTY immediately, but only when no other
     * tab on this page still holds the same session: the server's DELETE does
     * not consult the attachment count and always kills the process.
     *
     * Known limitation: `sessionHolders` only sees this page. Another browser
     * tab (or another device) attached to the same session would still be
     * killed. Fixing that requires a server-side change.
     */
    @bind
    private close(tabId: string, terminate = true) {
        const state = this.workspace;
        const tab = state.tabs.find(item => item.id === tabId);
        if (!tab) return;

        let sessionToDelete: string | undefined;
        if (terminate && tab.kind === 'terminal' && tab.sessionId) {
            const holders = sessionHolders(state, tab.sessionId);
            if (holders.every(id => id === tabId)) {
                sessionToDelete = tab.sessionId;
            }
        }

        // Update state first so Preact unmounts the Terminal and closes its
        // WebSocket before the DELETE request is sent.
        this.apply(closeTab(state, tabId, defaultMakeId));
        if (sessionToDelete) void this.deleteSession(sessionToDelete);
    }

    private async deleteSession(id: string) {
        try {
            const response = await fetch(`${this.props.sessionsUrl}/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                cache: 'no-store',
                credentials: 'same-origin',
            });
            // 204 deleted, 404 already gone, 403 not ours: none are retryable.
            // A network failure is fine too: server detach + reap_expired will
            // archive the session eventually.
            if (response.status === 403) {
                console.warn(`[ttyd] not allowed to delete session ${id}`);
            } else if (!response.ok && response.status !== 404) {
                console.warn(`[ttyd] delete session ${id}: HTTP ${response.status}`);
            }
        } catch (error) {
            console.warn(`[ttyd] delete session ${id} failed`, error);
        }
    }

    @bind
    private onTitleChange(tabId: string, title: string | undefined) {
        // Replay labels come from the history metadata, never from shell titles.
        if (this.workspace.tabs.find(tab => tab.id === tabId)?.kind === 'replay') return;
        this.apply(setTabTitle(this.workspace, tabId, title), true);
    }

    @bind
    private onLiveSessionIdChange(tabId: string, id: string | undefined) {
        this.apply(setTabSessionId(this.workspace, tabId, id));
    }

    @bind
    private onHistoryChange(tabId: string, id: string | undefined) {
        this.apply(setTabViewingHistory(this.workspace, tabId, id));
    }

    @bind
    private onRequestActivate(tabId: string) {
        this.activate(tabId);
    }

    @bind
    private onRequestClose(tabId: string) {
        // The socket already disconnected; the server detached and will reap
        // the session. Sending DELETE here would only widen the kill radius.
        this.close(tabId, false);
    }

    @bind
    private onLeaveAlertDisabled() {
        this.leaveAlertDisabled = true;
    }

    @bind
    private onConnectionFailed(tabId: string, message: string) {
        this.apply(setTabConnectionError(this.workspace, tabId, message));
    }

    /**
     * A session already open in a tab should be focused, not duplicated.
     * Prefer the currently active tab when it is one of the matches.
     */
    private activateMatch(match: (tab: TabState) => boolean): boolean {
        const { tabs, activeId } = this.workspace;
        const existing = tabs.find(tab => tab.id === activeId && match(tab)) ?? tabs.find(match);
        if (!existing) return false;
        this.activate(existing.id);
        return true;
    }

    @bind
    private attachSession(session: SessionSummary) {
        if (this.activateMatch(tab => tab.kind === 'terminal' && tab.sessionId === session.id)) return;
        this.addTerminalTab(session);
    }

    @bind
    private replaySession(session: SessionSummary) {
        if (this.activateMatch(tab => tab.kind === 'replay' && tab.historyId === session.id)) return;
        this.addReplayTab(session);
    }

    /** A DELETE succeeded in the panel; close related tabs without a second DELETE. */
    @bind
    private onSessionDeleted(id: string, kind: DeletedSessionKind) {
        let next = this.workspace;
        const ids = next.tabs
            .filter(tab =>
                kind === 'live'
                    ? tab.kind === 'terminal' && tab.sessionId === id
                    : tab.kind === 'replay' && tab.historyId === id
            )
            .map(tab => tab.id);
        if (ids.length === 0) return;

        for (const tabId of ids) {
            if (next.tabs.some(tab => tab.id === tabId)) {
                next = closeTab(next, tabId, defaultMakeId);
            }
        }
        this.apply(next);
    }

    private transferSessionId(): string | undefined {
        const tabId = this.transfer.tabId ?? this.workspace.activeId;
        const tab = this.workspace.tabs.find(item => item.id === tabId);
        return this.handles.get(tabId)?.getSessionId() ?? tab?.sessionId;
    }

    @bind
    private openTransfer(tabId: string, mode: TransferMode, files?: File[]) {
        this.transfer = { open: true, mode, tabId, droppedFiles: files };
        this.forceUpdate();
    }

    @bind
    private closeTransfer() {
        this.transfer = { ...this.transfer, open: false, droppedFiles: undefined };
        this.forceUpdate();
    }

    @bind
    private onTransferRequest(tabId: string, files: File[]) {
        this.openTransfer(tabId, 'upload', files);
    }

    render(props: WorkspaceProps, state: WorkspaceState) {
        const { tabs, activeId } = state;
        const activeTab = tabs.find(tab => tab.id === activeId);

        return (
            <div class="workspace">
                <div class="workspace-tabbar">
                    <div class="workspace-tabs" role="tablist" aria-label="Terminals">
                        {tabs.map(tab => (
                            <div
                                key={tab.id}
                                class={`workspace-tab${tab.id === activeId ? ' workspace-tab--active' : ''}${
                                    tab.connectionError ? ' workspace-tab--error' : ''
                                }`}
                                role="tab"
                                aria-selected={tab.id === activeId}
                                title={tab.connectionError ?? resolveTabTitle(tab)}
                                onClick={() => this.activate(tab.id)}
                            >
                                <span class="workspace-tab-label">{resolveTabTitle(tab)}</span>
                                <button
                                    class="workspace-tab-close"
                                    type="button"
                                    aria-label={`Close ${resolveTabTitle(tab)}`}
                                    onClick={event => {
                                        event.stopPropagation();
                                        this.close(tab.id);
                                    }}
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        class="workspace-add"
                        type="button"
                        aria-label="New tab"
                        title="New tab"
                        onClick={this.addEmptyTab}
                    >
                        +
                    </button>
                    <div class="workspace-tabbar-actions">
                        {props.transferEnabled && (
                            <button
                                class="workspace-transfer"
                                type="button"
                                title="Upload files over HTTP"
                                aria-label="Upload files"
                                onClick={() => this.openTransfer(activeId, 'upload')}
                            >
                                ↑ Upload
                            </button>
                        )}
                        {props.transferEnabled && (
                            <button
                                class="workspace-transfer"
                                type="button"
                                title="Download a file by its server path"
                                aria-label="Download file"
                                onClick={() => this.openTransfer(activeId, 'download')}
                            >
                                ↓ Download
                            </button>
                        )}
                        {activeTab?.kind === 'replay' && (
                            <button class="workspace-end-replay" type="button" onClick={() => this.close(activeTab.id)}>
                                End replay
                            </button>
                        )}
                        <SessionPanel
                            sessionsUrl={props.sessionsUrl}
                            viewingHistoryIds={replayHistoryIds(state)}
                            openIds={[...attachedSessionIds(state), ...replayHistoryIds(state)]}
                            onAuthRequired={props.onAuthRequired}
                            onAttach={this.attachSession}
                            onReplay={this.replaySession}
                            onAttachInNewTab={this.addTerminalTab}
                            onReplayInNewTab={this.addReplayTab}
                            onNewTab={this.addEmptyTab}
                            onDelete={this.onSessionDeleted}
                        />
                        {props.loginEnabled && (
                            <button
                                class="logout-button"
                                type="button"
                                onClick={props.onLogout}
                                disabled={props.loggingOut}
                            >
                                {props.loggingOut ? 'Signing out…' : 'Sign out'}
                            </button>
                        )}
                    </div>
                </div>

                <div class="workspace-panes">
                    {tabs.map(tab => (
                        <div
                            class="terminal-pane"
                            key={tab.id}
                            style={{ visibility: tab.id === activeId ? 'visible' : 'hidden' }}
                        >
                            <Terminal
                                key={tab.id}
                                tabId={tab.id}
                                active={tab.id === activeId}
                                initialSessionId={tab.kind === 'terminal' ? tab.sessionId : undefined}
                                initialHistory={
                                    tab.kind === 'replay' && tab.historyId
                                        ? {
                                              id: tab.historyId,
                                              command: tab.historyCommand ?? tab.title ?? '',
                                          }
                                        : undefined
                                }
                                wsUrl={props.wsUrl}
                                tokenUrl={props.tokenUrl}
                                sessionsUrl={props.sessionsUrl}
                                clientOptions={props.clientOptions}
                                termOptions={props.termOptions}
                                flowControl={props.flowControl}
                                sessionTimeout={props.sessionTimeout}
                                onAuthRequired={props.onAuthRequired}
                                onTitleChange={this.onTitleChange}
                                onLiveSessionIdChange={this.onLiveSessionIdChange}
                                onHistoryChange={this.onHistoryChange}
                                onReady={this.onReady}
                                onRequestActivate={this.onRequestActivate}
                                onRequestClose={this.onRequestClose}
                                onLeaveAlertDisabled={this.onLeaveAlertDisabled}
                                onConnectionFailed={this.onConnectionFailed}
                                transferEnabled={props.transferEnabled}
                                onTransferRequest={this.onTransferRequest}
                            />
                        </div>
                    ))}
                </div>

                {props.error && (
                    <div class="logout-error" role="alert">
                        {props.error}
                    </div>
                )}

                {props.transferEnabled && (
                    <TransferPanel
                        open={this.transfer.open}
                        mode={this.transfer.mode}
                        sessionsUrl={props.sessionsUrl}
                        sessionId={this.transferSessionId()}
                        droppedFiles={this.transfer.droppedFiles}
                        maxUpload={props.transferMaxUpload}
                        transferDir={props.transferDir}
                        followCwd={props.transferFollowCwd !== false}
                        onClose={this.closeTransfer}
                    />
                )}
            </div>
        );
    }
}
