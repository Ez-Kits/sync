import { DBStorageClosedError, TransactionClosedError, TransactionStatementError } from "./errors";
import { Mutex } from "./mutex";
import type { DBEngine, DBQuery, DBQueryResult } from "./types";

const DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000;

/** Whether a statement opens or ends a transaction (savepoints stay allowed). */
export function isTransactionControl(sql: string): boolean {
  const keyword = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase();
  if (keyword === "rollback") return !/^\s*rollback\s+(transaction\s+)?to\b/i.test(sql);
  return keyword === "begin" || keyword === "commit" || keyword === "end" || keyword === "start";
}

interface ActiveTransaction {
  id: string;
  owner: string;
  /** Statements of one transaction run in order even if sent concurrently. */
  tail: Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | undefined;
  release(): void;
}

/**
 * Serializes every statement on the leader's engine. A transaction holds the engine
 * exclusively from `begin` until `commit`/`rollback`, so statements of different
 * contexts never interleave inside it.
 */
export class TxScheduler {
  private readonly mutex = new Mutex();
  private active: ActiveTransaction | undefined;
  private closed = false;
  private nextId = 0;

  constructor(
    private readonly engine: DBEngine,
    private readonly options: { transactionTimeoutMs?: number } = {},
  ) {}

  /** The owner of the open transaction, if any; {@link abandon} rolls it back. */
  get activeOwner(): string | undefined {
    return this.active?.owner;
  }

  /**
   * Run a statement in transaction `txId`, or else on its own once no transaction is open.
   * A statement outside a transaction never joins one, whoever sent it: it would see
   * uncommitted rows and be rolled back with them. Work inside a transaction must use its
   * executor.
   */
  async exec(query: DBQuery, txId?: string): Promise<DBQueryResult> {
    if (txId !== undefined) return this.inTransaction(txId, () => this.engine.exec(query));
    if (isTransactionControl(query.sql)) throw new TransactionStatementError();
    return this.mutex.run(async () => {
      if (this.closed) throw new DBStorageClosedError();
      const result = await this.engine.exec(query);
      if (query.method === "run") await this.engine.flush?.();
      return result;
    });
  }

  /** Wait for exclusive use of the engine and open a transaction for `owner`. */
  begin(owner: string): Promise<string> {
    return new Promise((resolve, reject) => {
      void this.mutex.run(async () => {
        if (this.closed) {
          reject(new DBStorageClosedError());
          return;
        }
        try {
          await this.engine.exec({ sql: "BEGIN", params: [], method: "run" });
        } catch (error) {
          reject(error);
          return;
        }
        await new Promise<void>((release) => {
          const transaction: ActiveTransaction = {
            id: `tx-${++this.nextId}`,
            owner,
            tail: Promise.resolve(),
            timer: undefined,
            release,
          };
          this.active = transaction;
          this.armTimer(transaction);
          resolve(transaction.id);
        });
      });
    });
  }

  commit(txId: string): Promise<void> {
    return this.finish(txId, "COMMIT");
  }

  rollback(txId: string): Promise<void> {
    return this.finish(txId, "ROLLBACK");
  }

  /** Roll back the open transaction of an owner that went away. */
  async abandon(owner: string): Promise<void> {
    const active = this.active;
    if (active?.owner === owner) await this.finish(active.id, "ROLLBACK");
  }

  /** Roll back an open transaction, wait for queued statements, then close the engine. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    if (active) await this.finish(active.id, "ROLLBACK").catch(() => undefined);
    await this.mutex.run(async () => undefined);
    try {
      await this.engine.flush?.();
    } finally {
      await this.engine.close();
    }
  }

  private inTransaction<T>(txId: string, task: () => Promise<T>): Promise<T> {
    const active = this.active;
    if (active?.id !== txId) return Promise.reject(new TransactionClosedError());
    this.armTimer(active);
    const result = active.tail.then(task);
    active.tail = result.catch(() => undefined);
    return result;
  }

  private async finish(txId: string, statement: "COMMIT" | "ROLLBACK"): Promise<void> {
    const active = this.active;
    if (active?.id !== txId) {
      if (statement === "ROLLBACK") return;
      throw new TransactionClosedError();
    }
    // Close the transaction to new statements, but let queued ones finish first.
    this.active = undefined;
    clearTimeout(active.timer);
    try {
      await active.tail;
      try {
        await this.engine.exec({ sql: statement, params: [], method: "run" });
      } catch (error) {
        if (statement === "COMMIT") {
          await this.engine.exec({ sql: "ROLLBACK", params: [], method: "run" }).catch(() => {});
        }
        throw error;
      }
      if (statement === "COMMIT") await this.engine.flush?.();
    } finally {
      active.release();
    }
  }

  private armTimer(active: ActiveTransaction): void {
    clearTimeout(active.timer);
    const timeoutMs = this.options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
    active.timer = setTimeout(() => void this.rollback(active.id).catch(() => {}), timeoutMs);
  }
}
