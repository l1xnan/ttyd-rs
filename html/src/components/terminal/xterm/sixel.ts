/**
 * Primary device attributes advertised when Sixel is enabled.
 * `1;2` keeps xterm.js's VT100 response; `4` is the Sixel capability that
 * `img2sixel` and `lsix` look for.
 */
export const SIXEL_PRIMARY_DA = '\x1b[?1;2;4c';

/**
 * Response for a primary DA request (`CSI c` or `CSI 0 c`).
 * Any other parameter is left to xterm.js. Secondary DA (`CSI > c`) uses a
 * different function identifier and is not handled here.
 */
export function sixelPrimaryDeviceAttributes(params: ReadonlyArray<number | number[]>): string | undefined {
    const first = params[0];
    if (Array.isArray(first)) return undefined;
    if ((first ?? 0) !== 0) return undefined;
    return SIXEL_PRIMARY_DA;
}
