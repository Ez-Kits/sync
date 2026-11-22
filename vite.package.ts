import { defineConfig, type PluginOption } from "vite-plus";

interface PackageConfigOptions {
  /** Build entries; the bundler's default when left out. */
  entry?: string[] | Record<string, string>;
  /** Replaces the default test files, for a second config that runs other tests. */
  tests?: string[];
  /** Added to the default test files, e.g. `.test.tsx`. */
  extraTests?: string[];
  /** Added to the default type-level test files. */
  extraTypeTests?: string[];
  environment?: "jsdom";
  setupFiles?: string[];
  /** Added to the files coverage leaves out. */
  coverageExclude?: string[];
  /** Vite plugins, e.g. `cloudflareTest()` to run the tests in workerd. */
  plugins?: PluginOption[];
}

/** The Vite+ config every package under `packages/` shares. */
export function definePackageConfig(options: PackageConfigOptions = {}) {
  const {
    entry,
    tests = ["tests/**/*.test.ts"],
    extraTests = [],
    extraTypeTests = [],
    coverageExclude = [],
  } = options;
  return defineConfig({
    ...(options.plugins && { plugins: options.plugins }),
    pack: {
      dts: { generator: "tsgo" },
      exports: true,
      ...(entry && { entry }),
    },
    lint: { options: { typeAware: true, typeCheck: true } },
    fmt: {},
    test: {
      include: [...tests, ...extraTests],
      ...(options.environment && { environment: options.environment }),
      ...(options.setupFiles && { setupFiles: options.setupFiles }),
      // Type-level tests guarding the public API; run with `vp run test:types`.
      typecheck: {
        enabled: true,
        include: ["tests/types/**/*.test-d.ts", ...extraTypeTests],
        tsconfig: "./tsconfig.test.json",
      },
      coverage: {
        provider: "istanbul",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.d.ts", "src/**/types.ts", ...coverageExclude],
        reporter: ["text", "html"],
        thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  });
}
