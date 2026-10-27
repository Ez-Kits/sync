import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    projects: [
      "./packages/client-core",
      "./packages/client-drizzle",
      "./packages/client-react",
      "./packages/client-typeorm",
      "./packages/sync-firebase",
      "./packages/sync-conflict-resolution",
      "./packages/storage-sqljs",
      "./packages/storage-pglite",
      "./packages/storage-sqlite-wasm",
    ],
    coverage: {
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["packages/*/src/**/*.d.ts", "packages/*/src/**/types.ts"],
      reporter: ["text", "html"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
