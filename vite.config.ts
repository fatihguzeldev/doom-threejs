import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { playerConfig } from './game/vite.config.ts';

export default defineConfig({
  ...playerConfig,
  plugins: [...(playerConfig.plugins ?? []), {
    name: 'game-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'pocketvibe.json', source: readFileSync(new URL('./pocketvibe.json', import.meta.url), 'utf8') });
    },
  }],
});
