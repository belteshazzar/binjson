import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120000, // 30 seconds for persistent storage tests
    // *.browser.test.js needs a real browser (Worker/BroadcastChannel/
    // navigator.locks/OPFS) -- run those via `npm run test:browser`
    // (vitest.browser.config.js) instead.
    exclude: ['**/node_modules/**', 'test/*.browser.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
      exclude: ['node_modules/', 'test/']
    }
  }
});
