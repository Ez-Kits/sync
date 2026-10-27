import { faker } from "@faker-js/faker";
import { syncClient } from "../sync.ts";

const SEED_FLAG_KEY = "ez-sync-todo-seeded";
const SEED_COUNT = 10_000;
const SEED_YIELD_EVERY = 100;

/**
 * Inserts a large local todo dataset once per browser profile via the sync
 * client so creates are tracked as dirty local changes and can push upstream.
 */
export async function seedTodosOnce(): Promise<void> {
  if (localStorage.getItem(SEED_FLAG_KEY) === "1") {
    return;
  }

  // Works from any tab: reads and writes go to whichever tab owns the database.
  const existing = await syncClient.collections.todos.getMany();
  if (existing.length > 0) {
    localStorage.setItem(SEED_FLAG_KEY, "1");
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

  localStorage.setItem(SEED_FLAG_KEY, "1");
  console.info("Todo seed complete");
}
