import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const threeLicense = new URL('../LICENSE', pathToFileURL(createRequire(import.meta.url).resolve('three')));

export const playerConfig = defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  worker: { format: 'es' },
  plugins: [{
    name: 'player-licenses',
    generateBundle() {
      for (const [fileName, path] of [
        ['LICENSE', './LICENSE'],
        ['LICENSE-DOOM1.txt', './assets/LICENSE-DOOM1.txt'],
        ['LICENSE-OPL3.txt', './vendor/opl3/LICENSE'],
      ] as const)
        this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(path, import.meta.url), 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'LICENSE-THREE.txt', source: readFileSync(threeLicense, 'utf8') });
    },
  }],
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist/player', import.meta.url)),
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
});

export default defineConfig(({ mode }) => mode === 'player' ? playerConfig : {
  base: './',
  worker: { format: 'es' },
  build: {
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'game.js',
    },
    assetsInlineLimit: 0,
  },
});
