import { describe, expect, it } from 'vitest';
import { REPLAY_OUTPUT, bypassesTransferFilter } from './frames';

describe('output frame routing', () => {
    it('never feeds replayed output to the transfer filter', () => {
        expect(REPLAY_OUTPUT).toBe('5');
        expect(bypassesTransferFilter(REPLAY_OUTPUT, false)).toBe(true);
        expect(bypassesTransferFilter(REPLAY_OUTPUT, true)).toBe(true);
    });

    it('keeps read-only output out of the transfer filter', () => {
        expect(bypassesTransferFilter('0', true)).toBe(true);
    });

    it('lets live output reach trzsz and ZMODEM', () => {
        expect(bypassesTransferFilter('0', false)).toBe(false);
    });
});
