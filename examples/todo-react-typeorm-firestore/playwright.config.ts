import { defineConfig } from "@playwright/test";

// Not 4173: the Drizzle example previews there, and `reuseExistingServer` would test it.
const port = 4174;

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
    command: `vp run build && vp preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
