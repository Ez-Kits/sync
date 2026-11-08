import { definePackageConfig } from "../../vite.package";

export default definePackageConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  setupFiles: ["tests/setup.ts"],
});
