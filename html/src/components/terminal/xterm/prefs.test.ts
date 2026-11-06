import { describe, expect, it } from 'vitest';
import {
    DEFAULT_CLIENT_OPTIONS,
    DEFAULT_TRZSZ_DRAG_INIT_TIMEOUT,
    activePreferenceEntries,
    parseQueryOptions,
    resolveSessionTimeout,
} from './prefs';

describe('client options', () => {
    it('defaults trzsz drag initialization to 3000 ms', () => {
        expect(DEFAULT_CLIENT_OPTIONS.trzszDragInitTimeout).toBe(DEFAULT_TRZSZ_DRAG_INIT_TIMEOUT);
        expect(DEFAULT_TRZSZ_DRAG_INIT_TIMEOUT).toBe(3000);
        expect(DEFAULT_CLIENT_OPTIONS.enableZmodem).toBe(false);
        expect(DEFAULT_CLIENT_OPTIONS.enableTrzsz).toBe(false);
        expect(DEFAULT_CLIENT_OPTIONS.enableSixel).toBe(false);
    });

    it('parses true and 1 as booleans and the drag timeout as a number', () => {
        const parsed = parseQueryOptions(
            '?enableZmodem=true&enableTrzsz=1&enableSixel=false&trzszDragInitTimeout=1500&sessionTimeout=9',
            DEFAULT_CLIENT_OPTIONS
        );

        expect(parsed.enableZmodem).toBe(true);
        expect(parsed.enableTrzsz).toBe(true);
        expect(parsed.enableSixel).toBe(false);
        expect(parsed.trzszDragInitTimeout).toBe(1500);
        expect(parsed.sessionTimeout).toBeUndefined();
    });

    it('does not let an empty fixed title drop the transfer and Sixel switches', () => {
        const keys = activePreferenceEntries({
            titleFixed: '',
            enableZmodem: true,
            enableTrzsz: true,
            enableSixel: true,
        }).map(([key]) => key);

        expect(keys).toEqual(['enableZmodem', 'enableTrzsz', 'enableSixel']);
    });
});

describe('resolveSessionTimeout', () => {
    it('uses the server value and applies the query override', () => {
        expect(resolveSessionTimeout(30, '')).toBe(30);
        expect(resolveSessionTimeout(30, '?sessionTimeout=0')).toBe(0);
        expect(resolveSessionTimeout(0, '?sessionTimeout=45')).toBe(45);
        expect(resolveSessionTimeout(30, '?sessionTimeout=9999')).toBe(3600);
        expect(resolveSessionTimeout(Number.NaN, '?other=1')).toBe(0);
        expect(resolveSessionTimeout(-1, '?sessionTimeout=-5')).toBe(0);
    });
});
