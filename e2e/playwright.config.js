import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: '.',
    timeout: 120_000,
    use: {
        baseURL: 'http://localhost:8080',
        channel: 'chrome',
    },
});
