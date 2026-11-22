import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { mergeConfig } from "vite-plus";
import { definePackageConfig } from "../../vite.package";

// The server's tests, run in workerd. `vite.config.ts` runs the Node tests in `tests/`.
export default mergeConfig(
  definePackageConfig({
    tests: ["tests-workerd/**/*.test.ts"],
    plugins: [cloudflareTest({ wrangler: { configPath: "./tests-workerd/wrangler.jsonc" } })],
  }),
  { test: { name: "@ez-kits/sync-durable-object (workerd)" } },
);
