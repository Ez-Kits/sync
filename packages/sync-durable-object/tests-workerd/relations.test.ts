import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { httpPush, listEvent, uniqueScope } from "./helpers.ts";
import * as schema from "./schema.ts";

describe("db", () => {
  test("db.query runs relational queries with `with`", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "One" } }),
      listEvent({ type: "create", collection: "items", id: '["l1",1]', data: { title: "t" } }),
    ]);
    const lists = await runInDurableObject(env.TEST_SYNC.getByName(scope), (instance) =>
      instance.db.query.lists.findMany({ with: { items: { columns: { title: true } } } }),
    );
    expect(lists).toEqual([{ id: "l1", name: "One", createdAt: 0, items: [{ title: "t" }] }]);
    expectTypeOf(lists[0]!.items[0]!).toEqualTypeOf<{ title: string }>();
  });

  test("db is typed by the app's relations, and without relations by its tables only", async () => {
    await runInDurableObject(env.PLAIN_SYNC.getByName(uniqueScope()), (instance) => {
      const rows = instance.db.select({ name: schema.lists.name }).from(schema.lists).all();
      expect(rows).toEqual([]);
      expectTypeOf(rows).toEqualTypeOf<{ name: string }[]>();
      // @ts-expect-error: no relations, so no tables under db.query
      void instance.db.query.lists;
    });
    await runInDurableObject(env.TEST_SYNC.getByName(uniqueScope()), (instance) => {
      // Wrong table, column and relation names fail to compile; the builders aren't run.
      // @ts-expect-error: unknown table
      expect(instance.db.query.nope).toBeUndefined();
      // @ts-expect-error: unknown column
      void instance.db.query.lists.findMany({ columns: { nope: true } });
      // @ts-expect-error: unknown relation
      void instance.db.query.items.findMany({ with: { nope: true } });
    });
  });
});
