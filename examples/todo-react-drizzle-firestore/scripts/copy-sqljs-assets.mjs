#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlJsRoot = dirname(require.resolve("sql.js/package.json"));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

mkdirSync(publicDir, { recursive: true });
copyFileSync(join(sqlJsRoot, "dist", "worker.sql-wasm.js"), join(publicDir, "worker.sql-wasm.js"));
copyFileSync(join(sqlJsRoot, "dist", "sql-wasm.wasm"), join(publicDir, "sql-wasm.wasm"));

console.log("Copied sql.js worker assets to public/");
