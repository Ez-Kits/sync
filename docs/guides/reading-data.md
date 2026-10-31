# Reading data

You have three ways to read, from simplest to most powerful.

| Way                          | Use it for                                      | Updates by itself? |
| ---------------------------- | ----------------------------------------------- | ------------------ |
| `collections.<name>.get`     | one record by primary key                       | no                 |
| `collections.<name>.getMany` | every record of a collection                    | no                 |
| `client.liveQuery`           | any ORM query (filters, sorting, joins, counts) | **yes**            |

All reads wait until the database is ready, so you can call them right after creating the client.

## Simple reads

```ts
const todo = await client.collections.todos.get(id); // rejects if the record does not exist
const all = await client.collections.todos.getMany();
```

## Live queries

A live query runs your ORM query now, then again every time one of its collections changes: after a local write in any tab, and after remote changes are pulled.

```ts
const stop = client.liveQuery({
  collections: ["todos"], // re-run only when these change; leave out to re-run on any change
  query: (db, schema) => db.select().from(schema.todos),
  onData: (rows) => render(rows),
});

// Later, when the view goes away:
stop();
```

- `query` receives the ORM's query builder (`db`) and the schema (`schema`, your tables or entities by collection name). It may return a value or a promise.
- `onData` is called with each new result.
- `collections` is optional but recommended: without it, the query re-runs on changes to **any** collection.
- The return value stops the live query.

### With Drizzle

`db` is a Drizzle database. Both the SQL-like API and the relational query API work:

```ts
import { and, desc, eq, like, sql } from "drizzle-orm";
import { todos } from "./db/schema";

// SQL-like
client.liveQuery({
  collections: ["todos"],
  query: (db) =>
    db
      .select()
      .from(todos)
      .where(and(eq(todos.completed, false), like(todos.title, "%milk%")))
      .orderBy(desc(todos.updatedAt))
      .limit(50),
  onData: render,
});

// Relational queries: available for every collection without writing defineRelations
client.liveQuery({
  collections: ["todos"],
  query: (db) =>
    db.query.todos.findMany({
      where: { completed: false },
      orderBy: { updatedAt: "desc" },
      limit: 50,
    }),
  onData: render,
});

// Aggregates
client.liveQuery({
  collections: ["todos"],
  query: (db) => db.select({ count: sql<number>`count(*)` }).from(todos),
  onData: ([row]) => showCount(Number(row?.count ?? 0)),
});
```

To use relations between collections (`with: { ... }`), pass your own `relations` from `defineRelations` to the adapter. See the [Drizzle adapter reference](../api/client-drizzle-adapter.md#relations).

### With TypeORM

`db` is a TypeORM `DataSource` with a typed `repositories` map, one repository per collection:

```ts
import { Like } from "typeorm";

client.liveQuery({
  collections: ["todos"],
  query: (db) =>
    db.repositories.todos.find({
      where: { completed: false, title: Like("%milk%") },
      order: { updatedAt: "DESC" },
      take: 50,
    }),
  onData: render,
});
```

You can also use `db.getRepository(Todo)`, `db.createQueryBuilder()` or `db.query(sql)`.

## Listen to changes without querying

`client.subscribe` tells you **what** changed, without running a query. It is useful for logging, notifications or cache invalidation.

```ts
// Every change of every collection
const stop = client.subscribe((events) => console.log(events));

// One collection, or a list of collections
client.subscribe("todos", (events) => {
  for (const event of events) {
    if (event.type === "delete") console.log("deleted", event.id);
    else console.log(event.type, event.data);
  }
});

// Only writes made in this tab, or only changes that came from elsewhere
client.subscribe("todos", onLocal, { stream: "local" });
client.subscribe(["todos", "projects"], onRemote, { stream: "remote" });
```

Each event is `{ type: "create" | "update", collection, data }` or `{ type: "delete", collection, id, deletedAt? }`. `stream` defaults to `"both"`:

- `"local"`: writes made through `client.collections` **in this tab**.
- `"remote"`: everything else: changes pulled from the backend, and writes made in **other tabs**.

## Reads are local

Every read hits the **local** database, never the network. Data from the backend appears after it has been pulled. If a just-installed app shows an empty list, sync has not pulled yet: call `client.startSync()` (see [Syncing](syncing.md)).

## Do not write with the ORM

Reading through `db` is fine. Writing through it is not: such writes skip the outbox and are never synced. Use [`client.collections`](collections-and-writes.md) for writes.

## Next

- [React](react.md): the `useLiveQuery` hook.
- [Your database schema](database-schema.md): create the tables you query.
