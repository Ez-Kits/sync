import { faker } from "@faker-js/faker";
import type { TodoSyncClient } from "../sync.ts";

const SEED_FLAG_KEY_PREFIX = "ez-sync-todo-typeorm-seeded:";
const SEED_COUNT = 10_000;
const SEED_YIELD_EVERY = 100;

/**
 * Inserts a large local todo dataset once per account and browser profile via the sync
 * client so creates are tracked as dirty local changes and can push upstream.
 */
export async function seedTodosOnce(syncClient: TodoSyncClient, account: string): Promise<void> {
  const seedFlagKey = SEED_FLAG_KEY_PREFIX + account;
  if (localStorage.getItem(seedFlagKey) === "1") {
    return;
  }

  // Works from any tab: reads and writes go to whichever tab owns the database.
  const existing = await syncClient.collections.todos.getMany();
  if (existing.length > 0) {
    localStorage.setItem(seedFlagKey, "1");
    return;
  }

  console.info(`Seeding ${SEED_COUNT.toLocaleString()} todos via sync client (one-time)…`);

  for (let i = 0; i < SEED_COUNT; i++) {
    await syncClient.collections.todos.insert({
      id: faker.string.uuid(),
      title: faker.lorem.sentence(),
      completed: faker.datatype.boolean(),
      updatedAt: Date.now(),
    });

    const inserted = i + 1;
    if (inserted % SEED_YIELD_EVERY === 0 || inserted === SEED_COUNT) {
      console.info(`Seeded ${inserted.toLocaleString()}/${SEED_COUNT.toLocaleString()}`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  localStorage.setItem(seedFlagKey, "1");
  console.info("Todo seed complete");
}
