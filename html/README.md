# ttyd frontend

The frontend is bundled into a single HTML file that is embedded in the ttyd
binary.

## Prerequisites

- Node.js >= 22.12
- pnpm 12

## Development

1. Start ttyd: `ttyd bash`
2. Start the Vite dev server: `pnpm run dev`

The dev server listens on port 9000 and proxies `/token` and `/ws` to ttyd on
port 7681. If ttyd is started with `--check-origin`, start it without that flag
during development because the browser origin is the Vite server.

## Build

```sh
pnpm install
pnpm run check
pnpm run build
```

This writes:

- `dist/index.html` — single-file frontend
- `dist/index.html.gz` — compressed asset embedded by the Rust backend

## Compatibility notes

- TypeScript 7 is used for type checking. Linting and formatting are handled by oxlint and oxfmt.
- xterm.js 6 removed the canvas renderer addon. `rendererType=canvas` is still accepted for
  backwards compatibility, but falls back to the DOM renderer; use `webgl` or `dom` instead.
