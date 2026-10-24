# @ez-kits/sync-client-drizzle-adapter

Drizzle ORM adapter for the local database contract in `@ez-kits/sync-client-core`. It implements collection CRUD, query access, and transactional application of pulled remote changes. It supports scalar and composite primary keys when the collection configuration and Drizzle schema agree.

The adapter implements `getOptional` so an absent row is distinct from an underlying query error. Local mutations and the default IndexedDB outbox are separate persistence operations; this adapter does not claim cross-store atomicity. Apps that require atomic local edits and sync events can provide a database adapter implementing the core `commitLocalMutation` capability with a co-located outbox.

Use `schema` to provide the Drizzle table map explicitly, or allow it to be built from the defined collections. Keep application-specific schema and migrations under application control.

## Development

```bash
pnpm --filter @ez-kits/sync-client-drizzle-adapter build
pnpm --filter @ez-kits/sync-client-drizzle-adapter test
```
