import { describe, expect, it } from 'vitest';
import {
    formatEndedAt,
    formatExitCode,
    parseSessionsResponse,
    runningSessions,
    shortId,
    type SessionsResponse,
} from './sessions';

const payload = {
    sessions: [
        { id: 'live-1', owner: 'alice', command: 'bash', state: 'running', attached: 2 },
        { id: 'live-2', owner: 'alice', command: 'htop', state: 'running', attached: 0 },
    ],
    history: [
        {
            id: 'history-1',
            owner: 'alice',
            command: 'bash -l',
            state: 'exited',
            exitCode: 0,
            endedAt: 1762345678901,
        },
    ],
};

describe('parseSessionsResponse', () => {
    it('parses the documented payload', () => {
        const data = parseSessionsResponse(payload);

        expect(data?.sessions.map(session => session.id)).toEqual(['live-1', 'live-2']);
        expect(data?.sessions[0].owner).toBe('alice');
        expect(data?.sessions[0].attached).toBe(2);
        expect(data?.history[0]).toEqual({
            id: 'history-1',
            owner: 'alice',
            command: 'bash -l',
            state: 'exited',
            exitCode: 0,
            endedAt: 1762345678901,
        });
    });

    it('rejects values that are not a sessions payload', () => {
        expect(parseSessionsResponse(undefined)).toBeUndefined();
        expect(parseSessionsResponse(null)).toBeUndefined();
        expect(parseSessionsResponse('nope')).toBeUndefined();
        expect(parseSessionsResponse({ sessions: [], history: 'nope' })).toBeUndefined();
        expect(parseSessionsResponse({ sessions: {}, history: [] })).toBeUndefined();
    });

    it('drops malformed rows and tolerates missing groups', () => {
        const data = parseSessionsResponse({
            sessions: [
                { id: 'live-1', command: 'bash', state: 'running', attached: 1 },
                null,
                { id: '' },
                { command: 'x' },
            ],
        });

        expect(data?.sessions).toHaveLength(1);
        expect(data?.sessions[0].id).toBe('live-1');
        expect(data?.history).toEqual([]);
    });
});

describe('runningSessions', () => {
    it('excludes the session this tab is attached to', () => {
        const data = parseSessionsResponse(payload) as SessionsResponse;

        expect(runningSessions(data, 'live-1').map(session => session.id)).toEqual(['live-2']);
        expect(runningSessions(data, undefined).map(session => session.id)).toEqual(['live-1', 'live-2']);
        expect(runningSessions(undefined, 'live-1')).toEqual([]);
    });
});

describe('session formatting', () => {
    it('renders endedAt in local time', () => {
        const endedAt = new Date(2024, 0, 2, 3, 4).getTime();

        expect(formatEndedAt(endedAt)).toBe('2024-01-02 03:04');
        expect(formatEndedAt(undefined)).toBe('');
        expect(formatEndedAt(-1)).toBe('');
        expect(formatEndedAt(Number.NaN)).toBe('');
    });

    it('marks missing or negative exit codes as unknown', () => {
        expect(formatExitCode(0)).toBe('exit 0');
        expect(formatExitCode(7)).toBe('exit 7');
        expect(formatExitCode(-1)).toBe('exit unknown');
        expect(formatExitCode(undefined)).toBe('exit unknown');
    });

    it('shortens long ids only', () => {
        expect(shortId('0123456789abcdef')).toBe('01234567');
        expect(shortId('short')).toBe('short');
    });
});
