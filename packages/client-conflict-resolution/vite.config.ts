import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      generator: "tsgo",
    },
    exports: true,
    entry: ["src/index.ts"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
  test: {
    include: ["tests/**/*.test.ts"],
    // Type-level tests guarding the public API; run with `vp run test:types`.
    typecheck: {
      enabled: true,
      include: ["tests/types/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/types.ts"],
      reporter: ["text", "html"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
