import { defineConfig } from "@playwright/test";

const port = 4173;

/** Multi-tab tests: every page in one browser context shares Web Locks, BroadcastChannel and IndexedDB. */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  use: {
    baseURL: `http://localhost:${port}`,
    // Use the installed Chrome instead of downloading a Playwright browser.
    channel: "chrome",
  },
  webServer: {
    // A fresh, empty emulator for each run.
    command: `firebase emulators:exec --project demo-ezsync-todos --only firestore 'vp run build && vp preview --port ${port} --strictPort'`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    // Lets `firebase` stop its emulator; a kill would leave it holding the port.
    gracefulShutdown: { signal: "SIGINT", timeout: 10_000 },
    timeout: 120_000,
  },
});
