import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['game/tests/**/*.test.ts'],
    environment: 'node',
  },
});
