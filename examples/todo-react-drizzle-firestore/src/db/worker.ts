import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import {
  destroyWaSqliteDatabase,
  openWaSqliteEngine,
  type WaSqliteEngineOptions,
} from "@ez-kits/sync-client-storage-wa-sqlite/worker";
import { migrateLocalSchema } from "./migrations.ts";

/** Every tab runs this worker; only the elected leader's worker opens wa-sqlite. */
startDBStorageWorker<WaSqliteEngineOptions>({
  open: async (options) => {
    const engine = await openWaSqliteEngine(options);
    try {
      await migrateLocalSchema(engine);
    } catch (error) {
      await engine.close();
      throw error;
    }
    return engine;
  },
  destroy: destroyWaSqliteDatabase,
});
