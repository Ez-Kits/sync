import { definePackageConfig } from "../../vite.package";

export default definePackageConfig({
  extraTests: ["tests/**/*.test.tsx"],
  extraTypeTests: ["tests/types/**/*.test-d.tsx"],
  environment: "jsdom",
});
