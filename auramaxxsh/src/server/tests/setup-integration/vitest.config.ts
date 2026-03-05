import { defineConfig } from 'vitest/config';
import path from 'path';

const TEST_DATA_DIR = path.resolve(__dirname, '..', '..', 'test-data');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname, '..', '..'),
    include: ['tests/setup-integration/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/workerSetup.ts'],
    env: {
      NODE_ENV: 'test',
      WALLET_DATA_DIR: TEST_DATA_DIR,
      DATABASE_URL: `file:${path.join(TEST_DATA_DIR, 'test.db')}`,
      WS_BROADCAST_URL: '',
      WS_URL: '',
      BYPASS_RATE_LIMIT: 'true',
    },
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
