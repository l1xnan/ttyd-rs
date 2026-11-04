import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const distDir = fileURLToPath(new URL('./dist', import.meta.url));
const faviconPath = fileURLToPath(new URL('./src/favicon.png', import.meta.url));

/**
 * vite-plugin-singlefile only inlines JS and CSS. The favicon is referenced
 * from index.html, so inline it ourselves to keep the build a true single file.
 */
function inlineFavicon(): Plugin {
    const favicon = readFileSync(faviconPath).toString('base64');

    return {
        name: 'ttyd-inline-favicon',
        transformIndexHtml(html) {
            return html.replace(
                '<!-- favicon -->',
                `<link rel="icon" type="image/png" href="data:image/png;base64,${favicon}" />`
            );
        },
    };
}

/**
 * The Rust backend embeds dist/index.html.gz. Keep the compressed artifact
 * deterministic so builds can be checked into git and reproduced in CI.
 */
function gzipIndexHtml(): Plugin {
    return {
        name: 'ttyd-gzip-index',
        apply: 'build',
        enforce: 'post',
        closeBundle() {
            const html = readFileSync(`${distDir}/index.html`);
            const gzip = gzipSync(html, { level: 9 });
            // Node's gzip header has a zero mtime by default; make it explicit
            // in case the default changes.
            gzip[4] = 0;
            gzip[5] = 0;
            gzip[6] = 0;
            gzip[7] = 0;
            // Node inherits the platform OS byte from zlib; force a stable value.
            gzip[9] = 0;
            writeFileSync(`${distDir}/index.html.gz`, gzip);
        },
    };
}

export default defineConfig({
    base: './',
    publicDir: false,
    plugins: [inlineFavicon(), preact(), viteSingleFile({ removeViteModuleLoader: true }), gzipIndexHtml()],
    build: {
        target: 'es2020',
        cssCodeSplit: false,
        assetsInlineLimit: 100_000_000,
        sourcemap: false,
    },
    server: {
        port: 9000,
        strictPort: true,
        proxy: {
            '/login': {
                target: 'http://127.0.0.1:7681',
                changeOrigin: true,
            },
            '/logout': {
                target: 'http://127.0.0.1:7681',
                changeOrigin: true,
            },
            '/token': {
                target: 'http://127.0.0.1:7681',
                changeOrigin: true,
            },
            '/sessions': {
                target: 'http://127.0.0.1:7681',
                changeOrigin: true,
            },
            '/ws': {
                target: 'ws://127.0.0.1:7681',
                ws: true,
                changeOrigin: true,
            },
        },
    },
});
