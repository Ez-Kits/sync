# Installation

You install EzSync as a few small packages. A typical app needs **four**: the core, one DB adapter, one storage engine and (optionally) one sync adapter.

## Requirements

- A modern browser with **Web Workers**, **Web Locks** and **BroadcastChannel** (every current Chrome, Edge, Firefox and Safari).
- A bundler that can load a worker from a module, such as Vite (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`).
- TypeScript is recommended. All packages are ESM only.
- For Node.js scripts and tests: Node 24 or newer. See [Node.js and tests](../guides/node-and-tests.md).

## Step 1: pick one package from each row

| You need...                       | Pick one                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The core (always)                 | `@ez-kits/sync-client-core`                                                                                                                                                                         |
| An ORM bridge (a **DB adapter**)  | `@ez-kits/sync-client-drizzle-adapter` + `drizzle-orm` **or** `@ez-kits/sync-client-typeorm-adapter` + `typeorm`                                                                                    |
| A database (a **storage engine**) | `@ez-kits/sync-client-storage-sqljs` + `sql.js` **or** `@ez-kits/sync-client-storage-sqlite-wasm` + `@sqlite.org/sqlite-wasm` **or** `@ez-kits/sync-client-storage-pglite` + `@electric-sql/pglite` |
| A backend (a **sync adapter**)    | `@ez-kits/sync-client-firebase` + `firebase`, or [your own](../extending/custom-sync-adapter.md), or none for local-only                                                                            |
| Optional extras                   | `@ez-kits/sync-client-react` (React hooks), `@ez-kits/sync-client-conflict-resolution` (conflict policies)                                                                                          |

Not sure? Use the **recommended starter stack**. It is what the quick start uses:

- **Drizzle** (fully typed queries, no decorators),
- **sql.js** (smallest setup, works everywhere),
- **Firestore** (if you want a hosted backend),
- **React** bindings (if your app uses React).

The SQL dialect must match: sql.js and SQLite WASM speak **SQLite**; PGlite speaks **Postgres**. Both ORM adapters support both dialects. See [Choosing a storage engine](../guides/storage-engines.md) for the trade-offs.

## Step 2: install

The recommended starter stack:

```bash
npm install @ez-kits/sync-client-core \
  @ez-kits/sync-client-drizzle-adapter drizzle-orm@1.0.0-rc.5 \
  @ez-kits/sync-client-storage-sqljs sql.js \
  @ez-kits/sync-client-react \
  @ez-kits/sync-client-firebase firebase
```

With pnpm or Yarn, replace `npm install` with `pnpm add` or `yarn add`.

Add the sql.js types for TypeScript:

```bash
npm install -D @types/sql.js
```

### Version notes

| Peer dependency           | Version EzSync is built and tested against                               |
| ------------------------- | ------------------------------------------------------------------------ |
| `drizzle-orm`             | `1.0.0-rc.5` (the 1.0 line with `defineRelations`; 0.x is not supported) |
| `typeorm`                 | `^0.3.28`                                                                |
| `sql.js`                  | `^1.14.1`                                                                |
| `@sqlite.org/sqlite-wasm` | `3.54.1-build1`                                                          |
| `@electric-sql/pglite`    | `^0.3.16`                                                                |
| `firebase`                | `^12.12.1`                                                               |
| `react`                   | `^19.2`                                                                  |

### Extra setup for TypeORM

TypeORM uses decorators. Install `reflect-metadata`, import it once before your entities, and enable decorators in `tsconfig.json`:

```bash
npm install @ez-kits/sync-client-typeorm-adapter typeorm reflect-metadata
```

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

## Step 3: check your bundler

The storage engine runs in a **Web Worker** that you create. With Vite this works out of the box. A few engines need one extra line of configuration; it is listed on each engine's page in [Choosing a storage engine](../guides/storage-engines.md).

## Next step

Go to the [Quick start](quick-start.md) and build your first app.
