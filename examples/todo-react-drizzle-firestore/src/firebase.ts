import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";

// A `demo-` project exists only in the emulator: no Firebase account, and nothing leaves this
// machine. A real app passes its own Firebase config and calls `getFirestore(app)`.
const app = initializeApp({ apiKey: "demo-api-key", projectId: "demo-ezsync-todos" });

// Through this page's own origin, which `vite.config.ts` proxies to the emulator, so the app
// also syncs when opened from another device through a tunnel.
export const firestore = initializeFirestore(app, {
  host: location.host,
  ssl: location.protocol === "https:",
});
// An app using Firebase Auth would export `getAuth(app)` here too; see `sync.ts` for retrying
// the writes parked while signed out.
