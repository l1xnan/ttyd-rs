/**
 * Server -> client frame carrying replayed history. The payload is the same as
 * command `0`, but these bytes were already consumed once before the reconnect,
 * so they must never reach the ZMODEM/trzsz parser again.
 */
export const REPLAY_OUTPUT = '5';

/**
 * Decide whether terminal output should be written verbatim instead of being
 * handed to the transfer addon.
 *
 * Read-only history and replayed output both bypass the filter: the former is
 * not interactive, the latter could otherwise re-trigger a `trz` upload prompt.
 */
export function bypassesTransferFilter(command: string, readOnly: boolean): boolean {
    return command === REPLAY_OUTPUT || readOnly;
}
