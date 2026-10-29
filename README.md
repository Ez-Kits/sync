# EzSync

EzSync is a modular, local-first sync library for TypeScript applications. The core package owns collection events, local change tracking, checkpoints, and sync lifecycle. Database adapters and remote provider adapters live in separate packages so applications can replace or add integrations without coupling the core to a specific database or backend.

## Packages

- `@ez-kits/sync-client-core`: framework- and provider-neutral client contracts and runtime.
- `@ez-kits/sync-client-drizzle-adapter`: local database adapter for Drizzle ORM.
- `@ez-kits/sync-client-typeorm-adapter`: local database adapter for TypeORM.
- `@ez-kits/sync-client-react`: React bindings.
- `@ez-kits/sync-storage-sqljs`, `@ez-kits/sync-storage-sqlite-wasm`, `@ez-kits/sync-storage-pglite`: `DBStorage` engines that run the database in a leader worker shared by every tab.
- `@ez-kits/sync-firebase`: Firestore and Realtime Database remote adapters.
- `@ez-kits/sync-conflict-resolution`: provider-neutral built-in conflict policies.

Pull checkpoints are stored in the local database with the synced rows and committed in the same transaction; the client's only checkpoint option is `checkpoint: { serialize, deserialize }`, needed when checkpoints hold non-JSON values such as a Firestore `Timestamp` (see the core README).

See each package README for setup and adapter configuration. Firebase authentication and security rules are configured by the host application.

## Development

```bash
pnpm install
pnpm --filter @ez-kits/sync-client-core test
pnpm -r build
```

Client sync is evolving toward a stable production API. Review the package compatibility and durability notes before relying on cross-store atomicity or application-specific conflict behavior.
