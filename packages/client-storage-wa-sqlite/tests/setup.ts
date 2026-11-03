import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { vi } from "vite-plus/test";

// The wa-sqlite builds target browsers and fetch their .wasm file; hand it over in Node.
const wasmBinary = (file: string) =>
  readFileSync(new URL(`../node_modules/@journeyapps/wa-sqlite/dist/${file}`, import.meta.url));

vi.mock("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs", async (importOriginal) => {
  const { default: factory } = await importOriginal<{ default: (config: object) => unknown }>();
  return { default: () => factory({ wasmBinary: wasmBinary("wa-sqlite.wasm") }) };
});

vi.mock("@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs", async (importOriginal) => {
  const { default: factory } = await importOriginal<{ default: (config: object) => unknown }>();
  return { default: () => factory({ wasmBinary: wasmBinary("wa-sqlite-async.wasm") }) };
});

// Browsers accept the DOMStringList IDBBatchAtomicVFS passes to `transaction`; fake-indexeddb
// wants an array.
const transaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "transaction")!
  .value as IDBDatabase["transaction"];
IDBDatabase.prototype.transaction = function (
  this: IDBDatabase,
  names: string | Iterable<string>,
  ...rest: [IDBTransactionMode?, IDBTransactionOptions?]
) {
  return transaction.call(this, typeof names === "string" ? names : [...names], ...rest);
} as typeof transaction;
