import { defineConfig } from "drizzle-kit";

// Generates the test schema's migrations: `vp exec drizzle-kit generate --config tests-workerd/drizzle.config.ts`.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./tests-workerd/schema.ts",
  out: "./tests-workerd/drizzle",
});
