export interface SessionSummary {
    id: string;
    owner?: string;
    command: string;
    state: string;
    attached?: number;
    exitCode?: number;
    endedAt?: number;
}

export interface SessionsResponse {
    sessions: SessionSummary[];
    history: SessionSummary[];
}

function parseSummary(value: unknown): SessionSummary | undefined {
    if (!value || typeof value !== 'object') return undefined;

    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.command !== 'string') {
        return undefined;
    }

    const summary: SessionSummary = {
        id: raw.id,
        command: raw.command,
        state: typeof raw.state === 'string' ? raw.state : '',
    };
    if (typeof raw.owner === 'string') summary.owner = raw.owner;
    if (typeof raw.attached === 'number' && Number.isFinite(raw.attached)) {
        summary.attached = Math.max(Math.trunc(raw.attached), 0);
    }
    if (typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode)) {
        summary.exitCode = Math.trunc(raw.exitCode);
    }
    if (typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt)) {
        summary.endedAt = Math.trunc(raw.endedAt);
    }
    return summary;
}

function parseList(value: unknown): SessionSummary[] | undefined {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return undefined;

    const list: SessionSummary[] = [];
    for (const item of value) {
        const summary = parseSummary(item);
        if (summary) list.push(summary);
    }
    return list;
}

/** Parse `GET /sessions` defensively; malformed rows are dropped. */
export function parseSessionsResponse(input: unknown): SessionsResponse | undefined {
    if (!input || typeof input !== 'object') return undefined;

    const raw = input as Record<string, unknown>;
    const sessions = parseList(raw.sessions);
    const history = parseList(raw.history);
    if (!sessions || !history) return undefined;
    return { sessions, history };
}

/** Live sessions except the ones this page is already attached to. */
export function runningSessions(
    data: SessionsResponse | undefined,
    currentId?: string | readonly string[]
): SessionSummary[] {
    if (!data) return [];
    const excluded = new Set(currentId === undefined ? [] : typeof currentId === 'string' ? [currentId] : currentId);
    return data.sessions.filter(session => !excluded.has(session.id));
}

export function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
}

/** `endedAt` is Unix epoch milliseconds; render it in the browser's time zone. */
export function formatEndedAt(ms?: number): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';

    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';

    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatExitCode(code?: number): string {
    if (typeof code !== 'number' || !Number.isFinite(code) || code < 0) return 'exit unknown';
    return `exit ${Math.trunc(code)}`;
}
