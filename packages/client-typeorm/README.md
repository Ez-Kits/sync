# TypeORM DB adapter

`@ez-kits/sync-client-typeorm-adapter` connects the sync client to a TypeORM `DataSource`. It implements the core `DBAdapter` operations and runs transactional callbacks through a TypeORM `EntityManager`.

```ts
import { createTypeOrmDBAdapter } from "@ez-kits/sync-client-typeorm-adapter";

const dbAdapter = createTypeOrmDBAdapter({
  db: dataSource,
  collections,
});
```

Pass `dbAdapter` to the sync client as its database adapter. Configure collection entity schemas through `collections`, or provide a matching `schema` map when using entities defined elsewhere.

`get` rejects when a record is missing. `getOptional` returns `undefined` for a missing record and still rejects on database errors, allowing the sync engine to distinguish absence from a failed query. Both methods support scalar and composite primary keys.

`transaction` executes its callback against the transaction-scoped manager and exposes the same CRUD operations, including `getOptional`. TypeORM persistence and the client outbox are separate stores, so this adapter does not implement atomic local-mutation/outbox commits; the core uses its documented best-effort persistence path.
