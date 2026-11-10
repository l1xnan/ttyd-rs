export interface HandshakeOptions {
    token: string;
    columns: number;
    rows: number;
    session?: string;
    sessionTimeout: number;
    attachOnly?: boolean;
    /** This client understands command `5` for replayed output. */
    replayFrames?: boolean;
}

/**
 * Build the first WebSocket message. `attachOnly` selects a read-only history
 * replay and is only present when it is actually requested.
 */
export function buildHandshake(options: HandshakeOptions): string {
    const message: Record<string, unknown> = {
        AuthToken: options.token,
        columns: options.columns,
        rows: options.rows,
        session: options.session,
        sessionTimeout: options.sessionTimeout,
    };
    if (options.attachOnly === true) {
        message.attachOnly = true;
    }
    if (options.replayFrames === true) {
        message.replayFrames = true;
    }
    return JSON.stringify(message);
}

export interface ReadonlyFrame {
    readonly: true;
    exitCode: number;
}

const textDecoder = new TextDecoder();

/**
 * Parse the payload of a read-only replay frame (server command '4'), for
 * example `{"readonly":true,"exitCode":0}`.
 */
export function parseReadonlyFrame(bytes: Uint8Array): ReadonlyFrame | undefined {
    let value: unknown;
    try {
        value = JSON.parse(textDecoder.decode(bytes));
    } catch {
        return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;

    const frame = value as Record<string, unknown>;
    if (frame.readonly !== true || typeof frame.exitCode !== 'number' || !Number.isFinite(frame.exitCode)) {
        return undefined;
    }
    return { readonly: true, exitCode: Math.trunc(frame.exitCode) };
}
