import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Database tests share one schema; run files one after another.
    fileParallelism: false,
    // Generous limits so the suite also passes against a remote database
    // (e.g. a Neon scratch database on Replit), where each round trip is slower.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
