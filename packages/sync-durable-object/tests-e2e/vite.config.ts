import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { mergeConfig } from "vite-plus";
import { definePackageConfig } from "../../../vite.package";

const root = fileURLToPath(new URL("..", import.meta.url));

// The client adapter and a real sync client against the real object, all in workerd.
export default mergeConfig(
  definePackageConfig({
    tests: ["tests-e2e/**/*.test.ts"],
    plugins: [cloudflareTest({ wrangler: { configPath: `${root}tests-e2e/wrangler.jsonc` } })],
  }),
  { root, test: { name: "@ez-kits/sync-durable-object (e2e)" } },
);
