import { defineConfig } from '@playwright/test';

const PORT = process.env.E2E_PORT || '8080';
// The server serves HTTPS with a self-signed cert by default (see gen-cert.sh).
const PROTOCOL = process.env.E2E_PROTOCOL || 'https';

export default defineConfig({
    testDir: '.',
    timeout: 120_000,
    // Two-browser sync tests are timing sensitive; run them serially.
    workers: 1,
    use: {
        baseURL: process.env.BASE_URL || `${PROTOCOL}://localhost:${PORT}`,
        channel: 'chrome',
        ignoreHTTPSErrors: true,
    },
});
