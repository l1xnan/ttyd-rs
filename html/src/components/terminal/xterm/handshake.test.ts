import { describe, expect, it } from 'vitest';
import { buildHandshake, parseReadonlyFrame } from './handshake';

const encode = (value: string) => new TextEncoder().encode(value);

describe('websocket handshake', () => {
    it('omits attachOnly for a normal connection', () => {
        const message = JSON.parse(
            buildHandshake({
                token: 'secret',
                columns: 80,
                rows: 24,
                session: 'live-id',
                sessionTimeout: 30,
            })
        );

        expect(message).toEqual({
            AuthToken: 'secret',
            columns: 80,
            rows: 24,
            session: 'live-id',
            sessionTimeout: 30,
        });
        expect(Object.prototype.hasOwnProperty.call(message, 'attachOnly')).toBe(false);
    });

    it('omits the session and attachOnly keys for a brand new session', () => {
        const message = JSON.parse(
            buildHandshake({
                token: 'secret',
                columns: 100,
                rows: 40,
                sessionTimeout: 0,
            })
        );

        expect(message.session).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(message, 'session')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(message, 'attachOnly')).toBe(false);
    });

    it('adds attachOnly: true for a history replay', () => {
        const message = JSON.parse(
            buildHandshake({
                token: 'secret',
                columns: 80,
                rows: 24,
                session: 'history-id',
                sessionTimeout: 30,
                attachOnly: true,
            })
        );

        expect(message.attachOnly).toBe(true);
        expect(message.session).toBe('history-id');
        expect(message.sessionTimeout).toBe(30);
    });

    it('advertises replay frame support so the server can use command 5', () => {
        const message = JSON.parse(
            buildHandshake({
                token: 'secret',
                columns: 80,
                rows: 24,
                session: 'live-id',
                sessionTimeout: 30,
                replayFrames: true,
            })
        );

        expect(message.replayFrames).toBe(true);
    });

    it('omits replayFrames when the caller does not opt in', () => {
        const message = JSON.parse(
            buildHandshake({
                token: 'secret',
                columns: 80,
                rows: 24,
                sessionTimeout: 30,
            })
        );

        expect(Object.prototype.hasOwnProperty.call(message, 'replayFrames')).toBe(false);
    });
});

describe('readonly replay frame', () => {
    it('parses readonly and the exit code', () => {
        expect(parseReadonlyFrame(encode('{"readonly":true,"exitCode":7}'))).toEqual({
            readonly: true,
            exitCode: 7,
        });
    });

    it('truncates a fractional exit code', () => {
        expect(parseReadonlyFrame(encode('{"readonly":true,"exitCode":2.9}'))).toEqual({
            readonly: true,
            exitCode: 2,
        });
    });

    it('returns undefined for invalid or unrelated payloads', () => {
        expect(parseReadonlyFrame(encode('not json'))).toBeUndefined();
        expect(parseReadonlyFrame(encode(''))).toBeUndefined();
        expect(parseReadonlyFrame(encode('null'))).toBeUndefined();
        expect(parseReadonlyFrame(encode('{"readonly":false,"exitCode":0}'))).toBeUndefined();
        expect(parseReadonlyFrame(encode('{"exitCode":0}'))).toBeUndefined();
        expect(parseReadonlyFrame(encode('{"readonly":true}'))).toBeUndefined();
        expect(parseReadonlyFrame(encode('{"readonly":true,"exitCode":"0"}'))).toBeUndefined();
    });
});
