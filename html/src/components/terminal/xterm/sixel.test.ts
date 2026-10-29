import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { SIXEL_PRIMARY_DA, sixelPrimaryDeviceAttributes } from './sixel';

describe('Sixel device attributes', () => {
    it('adds parameter 4 to a primary DA request', () => {
        expect(sixelPrimaryDeviceAttributes([])).toBe(SIXEL_PRIMARY_DA);
        expect(sixelPrimaryDeviceAttributes([0])).toBe('\x1b[?1;2;4c');
        expect(SIXEL_PRIMARY_DA.split(';')).toContain('4c');
        expect(sixelPrimaryDeviceAttributes([1])).toBeUndefined();
    });

    it('leaves the secondary DA reply to xterm.js', async () => {
        const terminal = new Terminal({ allowProposedApi: true, rows: 8, cols: 40 });
        const replies: string[] = [];
        terminal.onData(data => replies.push(data));
        terminal.parser.registerCsiHandler({ final: 'c' }, params => {
            const reply = sixelPrimaryDeviceAttributes(params);
            if (!reply) return false;
            terminal.input(reply, false);
            return true;
        });

        await new Promise<void>(resolve => terminal.write('\x1b[c', () => resolve()));
        expect(replies.join('')).toBe(SIXEL_PRIMARY_DA);

        replies.length = 0;
        await new Promise<void>(resolve => terminal.write('\x1b[>c', () => resolve()));
        const secondary = replies.join('');
        expect(secondary).toBe('\x1b[>0;276;0c');
        expect(secondary.includes(';4')).toBe(false);
        terminal.dispose();
    });
});
