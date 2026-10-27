import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  DBStorageClosedError,
  TransactionClosedError,
  TransactionStatementError,
  isTransactionControl,
} from "../src/db-storage";
import { TxScheduler } from "../src/db-storage/tx-scheduler";
import { memoryEngine, q } from "./helpers/db-storage";

afterEach(() => {
  vi.useRealTimers();
});

test("transaction control statements are recognised; savepoints are not", () => {
  for (const sql of [
    "BEGIN",
    " begin immediate",
    "COMMIT",
    "end",
    "ROLLBACK",
    "start transaction",
  ]) {
    expect(isTransactionControl(sql)).toBe(true);
  }
  for (const sql of [
    "rollback to sp1",
    "ROLLBACK TRANSACTION TO sp",
    "savepoint sp1",
    "select 1",
    "",
  ]) {
    expect(isTransactionControl(sql)).toBe(false);
  }
});

test("writes outside a transaction are flushed; reads are not; raw BEGIN is rejected", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  await scheduler.exec(q("SET a 1"));
  expect(engine.flush).toHaveBeenCalledOnce();
  expect((await scheduler.exec(q("GET", "all"))).rows).toEqual([["a", "1"]]);
  expect(engine.flush).toHaveBeenCalledOnce();
  await expect(scheduler.exec(q("BEGIN"))).rejects.toBeInstanceOf(TransactionStatementError);
});

test("a transaction holds the engine: other statements wait until it ends", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  const tx = await scheduler.begin("a");
  expect(scheduler.activeOwner).toBe("a");
  const outside = scheduler.exec(q("SET outside 1"));
  const nextTx = scheduler.begin("b");
  await scheduler.exec(q("SET inside 1"), tx);
  await Promise.resolve();
  expect(engine.log).toEqual(["BEGIN", "SET inside 1"]);
  await scheduler.commit(tx);
  await outside;
  const second = await nextTx;
  expect(engine.log).toEqual(["BEGIN", "SET inside 1", "COMMIT", "SET outside 1", "BEGIN"]);
  await scheduler.exec(q("SET rolled 1"), second);
  await scheduler.rollback(second);
  expect([...engine.disk.rows.keys()]).toEqual(["inside", "outside"]);
  // Commit flushes; rollback does not.
  expect(engine.flush).toHaveBeenCalledTimes(2);
});

test("statements of one transaction run in order and a closed transaction rejects", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  const tx = await scheduler.begin("a");
  await Promise.all([
    scheduler.exec(q("WAIT 5"), tx),
    scheduler.exec(q("SET a 1"), tx),
    expect(scheduler.exec(q("FAIL"), tx)).rejects.toThrow("statement failed"),
  ]);
  expect(engine.log.slice(1)).toEqual(["WAIT 5", "SET a 1", "FAIL"]);
  await scheduler.commit(tx);
  await expect(scheduler.exec(q("SET b 1"), tx)).rejects.toBeInstanceOf(TransactionClosedError);
  await expect(scheduler.commit(tx)).rejects.toBeInstanceOf(TransactionClosedError);
  // Rolling back something already closed is a no-op.
  await scheduler.rollback(tx);
});

test("a failing COMMIT rolls back and releases the engine", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  const tx = await scheduler.begin("a");
  await scheduler.exec(q("SET a 1"), tx);
  engine.exec.mockRejectedValueOnce(new Error("disk full"));
  await expect(scheduler.commit(tx)).rejects.toThrow("disk full");
  expect(engine.log.at(-1)).toBe("ROLLBACK");
  expect(engine.disk.rows.size).toBe(0);
  await scheduler.exec(q("SET b 1"));
});

test("a failing BEGIN rejects without holding the engine", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  engine.exec.mockRejectedValueOnce(new Error("locked"));
  await expect(scheduler.begin("a")).rejects.toThrow("locked");
  await scheduler.exec(q("SET a 1"));
});

test("idle transactions time out, and an abandoned owner's transaction rolls back", async () => {
  vi.useFakeTimers();
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine, { transactionTimeoutMs: 50 });
  const tx = await scheduler.begin("a");
  await scheduler.exec(q("SET a 1"), tx);
  await vi.advanceTimersByTimeAsync(49);
  await scheduler.exec(q("SET b 1"), tx);
  await vi.advanceTimersByTimeAsync(49);
  expect(scheduler.activeOwner).toBe("a");
  await vi.advanceTimersByTimeAsync(1);
  expect(scheduler.activeOwner).toBeUndefined();
  expect(engine.disk.rows.size).toBe(0);
  await expect(scheduler.commit(tx)).rejects.toBeInstanceOf(TransactionClosedError);

  // Default timeout applies when none is configured.
  const defaults = new TxScheduler(memoryEngine());
  await defaults.begin("x");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(defaults.activeOwner).toBeUndefined();
  vi.useRealTimers();

  const owned = await scheduler.begin("b");
  await scheduler.exec(q("SET c 1"), owned);
  await scheduler.abandon("someone-else");
  expect(scheduler.activeOwner).toBe("b");
  await scheduler.abandon("b");
  expect(scheduler.activeOwner).toBeUndefined();
  expect(engine.disk.rows.has("c")).toBe(false);
});

test("close rolls back the open transaction, drains the queue and closes once", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  const tx = await scheduler.begin("a");
  await scheduler.exec(q("SET a 1"), tx);
  const queued = scheduler.exec(q("SET queued 1"));
  await scheduler.close();
  await scheduler.close();
  await expect(queued).rejects.toBeInstanceOf(DBStorageClosedError);
  expect(engine.disk.rows.size).toBe(0);
  expect(engine.close).toHaveBeenCalledOnce();
  await expect(scheduler.begin("b")).rejects.toBeInstanceOf(DBStorageClosedError);

  // The engine closes even when the final flush fails.
  const failing = memoryEngine();
  failing.flush.mockRejectedValueOnce(new Error("flush failed"));
  await expect(new TxScheduler(failing).close()).rejects.toThrow("flush failed");
  expect(failing.close).toHaveBeenCalledOnce();
});

test("engine failures while ending transactions are contained", async () => {
  vi.useFakeTimers();
  const engine = memoryEngine();
  const failing = new Set<string>();
  const exec = engine.exec.getMockImplementation()!;
  engine.exec.mockImplementation(async (query) => {
    const result = await exec(query);
    if (failing.has(query.sql)) throw new Error(`${query.sql} failed`);
    return result;
  });
  const scheduler = new TxScheduler(engine, { transactionTimeoutMs: 10 });
  failing.add("ROLLBACK");

  const rolledBack = await scheduler.begin("a");
  await expect(scheduler.rollback(rolledBack)).rejects.toThrow("ROLLBACK failed");

  failing.add("COMMIT");
  const committed = await scheduler.begin("a");
  await expect(scheduler.commit(committed)).rejects.toThrow("COMMIT failed");

  // A timed-out transaction whose rollback fails still frees the engine.
  await scheduler.begin("a");
  await vi.advanceTimersByTimeAsync(10);
  expect(scheduler.activeOwner).toBeUndefined();

  await scheduler.begin("a");
  await scheduler.close();
  expect(engine.close).toHaveBeenCalledOnce();
});

test("statements of the transaction owner join it instead of waiting for it", async () => {
  const engine = memoryEngine();
  const scheduler = new TxScheduler(engine);
  const tx = await scheduler.begin("a");
  await scheduler.exec(q("SET own 1"), undefined, "a");
  const other = scheduler.exec(q("SET other 1"), undefined, "b");
  expect((await scheduler.exec(q("GET", "all"), undefined, "a")).rows).toEqual([["own", "1"]]);
  await scheduler.rollback(tx);
  await other;
  // The owner's statement was part of the rolled-back transaction.
  expect([...engine.disk.rows.keys()]).toEqual(["other"]);
});
