// 'canvas' is kept for backwards compatibility with existing client options;
// xterm.js 6 removed the canvas addon and it falls back to the DOM renderer.
export type RendererType = 'dom' | 'canvas' | 'webgl';

export interface ClientOptions {
    rendererType: RendererType;
    disableLeaveAlert: boolean;
    disableResizeOverlay: boolean;
    enableZmodem: boolean;
    enableTrzsz: boolean;
    enableSixel: boolean;
    titleFixed?: string;
    isWindows: boolean;
    trzszDragInitTimeout: number;
    unicodeVersion: string;
    closeOnDisconnect: boolean;
}

export const DEFAULT_TRZSZ_DRAG_INIT_TIMEOUT = 3000;

export const DEFAULT_CLIENT_OPTIONS: ClientOptions = {
    rendererType: 'webgl',
    disableLeaveAlert: false,
    disableResizeOverlay: false,
    enableZmodem: false,
    enableTrzsz: false,
    enableSixel: false,
    closeOnDisconnect: false,
    isWindows: false,
    unicodeVersion: '11',
    trzszDragInitTimeout: DEFAULT_TRZSZ_DRAG_INIT_TIMEOUT,
};

/**
 * Options from the page query string. `sessionTimeout` is a session handshake
 * parameter, not a terminal option. An empty fixed title is omitted so later
 * options, including the transfer and Sixel switches, still apply.
 */
export function parseQueryOptions(
    query: string,
    clientOptions: object,
    terminalOptions: object = {}
): Record<string, any> {
    const prefs: Record<string, any> = {};
    const known = clientOptions as Record<string, unknown>;
    const terminal = terminalOptions as Record<string, unknown>;
    const params = new URLSearchParams(query);

    for (const [key, queryVal] of params) {
        if (key === 'sessionTimeout') continue;
        let current = known[key];
        if (current === undefined) current = terminal[key];
        switch (typeof current) {
            case 'boolean':
                prefs[key] = queryVal === 'true' || queryVal === '1';
                break;
            case 'number':
            case 'bigint':
                prefs[key] = Number.parseInt(queryVal, 10);
                break;
            case 'string':
                prefs[key] = queryVal;
                break;
            case 'object':
                prefs[key] = JSON.parse(queryVal);
                break;
            default:
                prefs[key] = queryVal;
                break;
        }
    }

    return prefs;
}

/** Skip a blank fixed title without dropping the options that follow it. */
export function activePreferenceEntries(prefs: object): Array<[string, any]> {
    const entries: Array<[string, any]> = [];
    for (const [key, value] of Object.entries(prefs)) {
        if (key === 'titleFixed' && (value === undefined || value === null || value === '')) continue;
        entries.push([key, value]);
    }
    return entries;
}
