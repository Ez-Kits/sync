import { defineConfig } from "vite-plus";

// Firestore's requests go to this page's origin (see `src/firebase.ts`), and on to the emulator.
const proxy = { "/google.firestore.v1.Firestore": "http://127.0.0.1:8086" };

export default defineConfig({
  server: {
    proxy,
    // Opening the dev server from a phone through `cloudflared tunnel --url`.
    allowedHosts: [".trycloudflare.com"],
  },
  preview: { proxy },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
