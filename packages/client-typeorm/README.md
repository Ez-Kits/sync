# TypeORM DB adapter

`@ez-kits/sync-client-typeorm-adapter` connects the sync client to a TypeORM `DataSource`. It implements the core `DBAdapter` operations and runs transactional callbacks through a TypeORM `EntityManager`.

Use `createTypeOrmStorage` to construct the database adapter and local-change store as a typed pair from the same `DataSource`. Event and dirty-record entity classes must expose the fields persisted by the sync client; invalid entity shapes fail type checking.

```ts
import { createTypeOrmStorage } from "@ez-kits/sync-client-typeorm-adapter";

const storage = createTypeOrmStorage({
  db: dataSource,
  collections,
  eventEntity: SyncEventEntity,
  dirtyRecordEntity: DirtyRecordEntity,
});

const client = createSyncClient({
  collections,
  storage,
});
```

Configure collection entity schemas through `collections`, or provide a matching `schema` map when using entities defined elsewhere.

`get` rejects when a record is missing. `getOptional` returns `undefined` for a missing record and still rejects on database errors, allowing the sync engine to distinguish absence from a failed query. Both methods support scalar and composite primary keys.

`transaction` executes its callback against the transaction-scoped manager and exposes the same CRUD operations, including `getOptional`. The paired adapter passes its transaction-scoped `EntityManager` to both store writes, so the row, outbox event, and dirty marker commit or roll back together. A store that cannot join the transaction cannot be paired, and local writes never fall back to sequential persistence.

The event entity must persist `id`, `type`, `collection`, `data`, `recordId`, and `createdAt`; use a JSON-capable column for `data`. The dirty-record entity must persist `collection`, `recordId`, `state`, and `updatedAt`, with a unique constraint on `(collection, recordId)`. Keep these entities and the collection entities in the same `DataSource` and database transaction.
