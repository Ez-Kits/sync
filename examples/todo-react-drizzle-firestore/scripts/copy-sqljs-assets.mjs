#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

mkdirSync(publicDir, { recursive: true });
copyFileSync(
  fileURLToPath(import.meta.resolve("sql.js/dist/worker.sql-wasm.js")),
  join(publicDir, "worker.sql-wasm.js"),
);
copyFileSync(
  fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm")),
  join(publicDir, "sql-wasm.wasm"),
);

console.log("Copied sql.js worker assets to public/");
