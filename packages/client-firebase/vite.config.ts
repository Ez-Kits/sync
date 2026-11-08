import { definePackageConfig } from "../../vite.package";

export default definePackageConfig({ entry: ["src/sync-firestore.ts", "src/sync-realtime-db.ts"] });
