# Extending EzSync

EzSync is a set of layers connected by small contracts. To support something new, implement the contract of **one** layer; the rest keeps working.

```
sync client ─────► SyncAdapter       ← "sync with my backend"
    │
DB adapter        (BaseDBAdapter)    ← "use my ORM / plain SQL"
    │
DB storage        (DBStorage)        ← rarely needed: the built-in coordination covers it
    │
DB engine         (DBEngine)         ← "use another database engine"
```

| I want to...                                                       | Build a...                                                        | Effort                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| Sync with my REST API, WebSocket server, Supabase, PocketBase, ... | [Sync adapter](custom-sync-adapter.md)                            | Small: two functions, `pull` and `push` |
| Use another SQL engine (wa-sqlite, `node:sqlite`, a native SQLite) | [DB engine](custom-db-storage.md)                                 | Small: one `exec` function              |
| Use another ORM (Kysely, MikroORM, ...) or plain SQL               | [DB adapter](custom-db-adapter.md)                                | Medium: CRUD + the outbox store         |
| Share a database in a way the worker storage cannot                | [DBStorage](custom-db-storage.md#implementing-dbstorage-directly) | Large; usually not needed               |

## Before you start

- Read [How EzSync works](../guides/how-it-works.md). The guarantees there are what your implementation must keep.
- The contracts are documented in the [core API reference](../api/client-core.md), and the source of truth is `packages/client-core/src`. Each built-in package is a working example:

  | Contract     | Look at                                                                         |
  | ------------ | ------------------------------------------------------------------------------- |
  | `DBEngine`   | `packages/storage-sqljs/src/engine.ts`, `packages/storage-pglite/src/engine.ts` |
  | DB adapter   | `packages/client-drizzle/src`, `packages/client-typeorm/src`                    |
  | Sync adapter | `packages/sync-firebase/src/firestore/create-sync-adapter-from-resolved.ts`     |

- Keep provider-, ORM- and engine-specific code in its own package. The core never imports it.
