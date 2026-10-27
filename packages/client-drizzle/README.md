# @ez-kits/sync-client-drizzle-adapter

Drizzle ORM adapter for the local database contract in `@ez-kits/sync-client-core`. It implements collection CRUD, query access, and transactional application of pulled remote changes. It supports scalar and composite primary keys when the collection configuration and Drizzle schema agree.

The adapter implements `getOptional` so an absent row is distinct from an underlying query error. Use `createDrizzleStorage` to build coordinated storage whose database adapter and local-change store share one Drizzle database. The event table schema must accept `id`, `type`, `collection`, `data`, `recordId`, and `createdAt`; the dirty table must accept `collection`, `recordId`, `state`, and `updatedAt`, with a unique key on `(collection, recordId)`. The store creator checks that required event and dirty fields are compatible with Drizzle's inferred insert models.

For a database that lives in one tab at a time (sql.js, wa-sqlite in a dedicated worker), only the elected tab opens it, and other tabs reach it through `drizzle-orm/sqlite-proxy`:

```ts
import { drizzle } from "drizzle-orm/sqlite-proxy";

const storage = createDrizzleStorage({
  coordinationKey: "todos",
  collections,
  localChangeTables: { events: syncEvents, dirtyRecords },
  open: async () => {
    const executors = await startSqliteWorker(); // { all, get, run } for sqlite-proxy
    return {
      database: drizzle(executors),
      execute: (request) => executeSqliteProxyRequest(executors, request),
    };
  },
  connect: (send) => drizzle(forwardSqliteProxy(send)),
});

const client = createSyncClient({ collections, storage, checkpointStorage });
```

Pass the same `schema`/`relations` options to both `drizzle()` calls so relational queries work in every tab. If the engine is already shared across tabs, use `sharing: "shared"` with an `open` that returns `{ database }`.

The paired adapter passes its native transaction to both local-change writes. The row, outbox event, and dirty record commit together or are rolled back together. A separate browser store such as IndexedDB cannot join this SQL transaction and cannot be paired with this adapter for local mutations; there is no best-effort fallback.

Use `schema` to provide the Drizzle table map explicitly, or allow it to be built from the defined collections. Keep application-specific schema and migrations under application control.

## Development

```bash
pnpm --filter @ez-kits/sync-client-drizzle-adapter build
pnpm --filter @ez-kits/sync-client-drizzle-adapter test
```
