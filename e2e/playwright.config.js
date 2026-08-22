import { defineConfig } from '@playwright/test';

const PORT = process.env.E2E_PORT || '8080';

export default defineConfig({
    testDir: '.',
    timeout: 120_000,
    // Two-browser sync tests are timing sensitive; run them serially.
    workers: 1,
    use: {
        baseURL: process.env.BASE_URL || `http://localhost:${PORT}`,
        channel: 'chrome',
    },
});
