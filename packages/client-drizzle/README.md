# @ez-kits/sync-client-drizzle-adapter

Drizzle ORM adapter for the local database contract in `@ez-kits/sync-client-core`. It implements collection CRUD, query access, and transactional application of pulled remote changes. It supports scalar and composite primary keys when the collection configuration and Drizzle schema agree.

The adapter implements `getOptional` so an absent row is distinct from an underlying query error. Use `createDrizzleStorage` to construct the database adapter and local-change store as a typed pair from the same Drizzle database. The event table schema must accept `id`, `type`, `collection`, `data`, `recordId`, and `createdAt`; the dirty table must accept `collection`, `recordId`, `state`, and `updatedAt`, with a unique key on `(collection, recordId)`. The store creator checks that required event and dirty fields are compatible with Drizzle's inferred insert models.

```ts
const storage = createDrizzleStorage({
  db,
  localChangeTables: { events: syncEvents, dirtyRecords },
  collections,
});

const client = createSyncClient({
  collections,
  storage,
});
```

The paired adapter passes its native transaction to both local-change writes. The row, outbox event, and dirty record commit together or are rolled back together. A separate browser store such as IndexedDB cannot join this SQL transaction and cannot be paired with this adapter for local mutations; there is no best-effort fallback.

Use `schema` to provide the Drizzle table map explicitly, or allow it to be built from the defined collections. Keep application-specific schema and migrations under application control.

## Development

```bash
pnpm --filter @ez-kits/sync-client-drizzle-adapter build
pnpm --filter @ez-kits/sync-client-drizzle-adapter test
```
