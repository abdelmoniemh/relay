import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Tizen loads the app from file://, where module scripts are unreliable: ship one classic script + Samsung's webapis. */
const tizenHtml = (): Plugin => ({
  name: 'tizen-html',
  enforce: 'post',
  transformIndexHtml: (html) => html
    .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '')
    .replace('</body>', '<script src="$WEBAPIS/webapis/webapis.js"></script>\n<script src="./assets/app.js"></script>\n</body>')
    .replace(/ crossorigin/g, '')
    .replace(/<link rel="manifest"[^>]*>/, ''),
});

export default defineConfig(({ mode }) => {
  const tizen = mode === 'tizen';
  return {
    plugins: [preact(), ...(tizen ? [tizenHtml()] : [])],
    base: tizen ? './' : '/',
    resolve: {
      dedupe: ['preact', '@preact/signals'],
      alias: {
        '@shared': r('../shared'),
        ...(tizen ? { 'hls.js': r('src/player/stub.ts'), 'mpegts.js': r('src/player/stub.ts') } : {}),
      },
    },
    define: { __TIZEN__: JSON.stringify(tizen), __DEFAULT_SERVER__: JSON.stringify(process.env.RELAY_SERVER ?? '') },
    build: {
      // Samsung TVs from 2019 (Tizen 5.0) run Chromium 63+.
      target: tizen ? 'chrome63' : 'es2020',
      cssTarget: tizen ? 'chrome63' : undefined,
      modulePreload: !tizen,
      emptyOutDir: true,
      rollupOptions: tizen ? { output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'assets/app.js' } } : undefined,
    },
    server: { proxy: { '/api': 'http://localhost:8787', '/ws': { target: 'ws://localhost:8787', ws: true } } },
  };
});
