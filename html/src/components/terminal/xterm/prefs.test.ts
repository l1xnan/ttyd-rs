import { describe, expect, it } from 'vitest';
import {
    DEFAULT_CLIENT_OPTIONS,
    DEFAULT_TRZSZ_DRAG_INIT_TIMEOUT,
    activePreferenceEntries,
    parseQueryOptions,
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
