# What is EzSync?

## The problem

Most web apps keep their data on a server. Every click waits for the network, and when the network is gone, the app stops working.

A **local-first** app flips this around. The data lives in a database **inside the browser**. The app reads and writes that local database, so it is instant and works offline. In the background, the changes are copied to a server, and changes made elsewhere (another device, another user) are copied back.

Doing the background copying correctly is hard. What if the user closes the tab in the middle of a save? What if two tabs are open? What if the server refuses a write? What if the same record was changed in two places? EzSync handles these cases for you.

## What EzSync does

- Gives you a **real SQL database in the browser** (SQLite or Postgres), saved between visits.
- Lets you query it with an **ORM you already know** (Drizzle or TypeORM).
- **Records every local write** in an "outbox" in the same transaction as the write itself, so no write is ever lost.
- **Pushes** the outbox to your backend when online, and **pulls** remote changes in.
- Works across **many open tabs** of the same app, all sharing one database.
- Lets you choose what happens when **local and remote edits conflict**.

## The five words you need to know

You will meet these names everywhere in the docs and the API.

| Word             | What it is                                                                                                | Example                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Collection**   | A kind of record your app syncs, backed by one table. You give it a name and a primary key.               | `todos`, `projects`                             |
| **DB storage**   | The local database engine, and the code that shares it between tabs.                                      | sql.js, SQLite WASM, PGlite                     |
| **DB adapter**   | The bridge between the DB storage and your ORM. It gives you a typed query builder and stores the outbox. | Drizzle adapter, TypeORM adapter                |
| **Sync adapter** | The bridge between EzSync and your backend. It pushes local changes and pulls remote ones.                | Firestore, Realtime Database, your own REST API |
| **Sync client**  | The object your app talks to. It ties the other four together.                                            | `client.collections.todos.insert(...)`          |

How they stack up:

```
      your app
         │   insert / update / delete, live queries
         ▼
    sync client  ───────────────►  sync adapter  ───►  your backend
         │                          (Firestore, ...)
         ▼
     DB adapter   (Drizzle, TypeORM)
         │
         ▼
     DB storage   (sql.js, SQLite WASM, PGlite)
```

You choose each piece separately. Any DB adapter works with any DB storage of the same SQL dialect (SQLite or Postgres), and any sync adapter works with any of them.

## What EzSync does not do

- It does not run your backend. You bring Firestore, the Realtime Database or your own server.
- It does not manage sign-in or security rules. Your app configures authentication and rules for its backend.
- It does not create **your** tables. You write their `CREATE TABLE` statements (EzSync creates only its own internal tables). See [Your database schema](../guides/database-schema.md).

## Next step

Go to [Installation](installation.md) to pick your packages.
