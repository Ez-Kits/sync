import type { DBExecutor, DBStorage } from "@ez-kits/sync-client-core";

/** Rolls back the storage transaction a `ROLLBACK` statement ended; never reaches callers. */
class RollbackSignal extends Error {}

interface OpenTransaction {
  readonly tx: DBExecutor;
  end(commit: boolean): Promise<void>;
}

/** A transaction TypeORM began; the storage transaction opens with its first statement. */
interface PendingTransaction {
  opened?: Promise<OpenTransaction>;
}

/** Hold a storage transaction open until TypeORM sends `COMMIT` or `ROLLBACK`. */
function openTransaction(dbStorage: DBStorage): Promise<OpenTransaction> {
  return new Promise((resolve, reject) => {
    let settle!: (commit: boolean) => void;
    const body = new Promise<void>((commit, rollback) => {
      settle = (ok) => (ok ? commit() : rollback(new RollbackSignal()));
    });
    const finished = dbStorage.transaction(async (tx) => {
      resolve({ tx, end });
      await body;
    });
    // Before the transaction opens this fails the first statement; afterwards `end` reports it.
    finished.catch(reject);
    async function end(commit: boolean) {
      settle(commit);
      await finished.catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });
    }
  });
}

export type StatementKind = "begin" | "commit" | "rollback" | "read" | "write";

/** How a driver connection must route a statement TypeORM sends. */
export function statementKind(sql: string): StatementKind {
  const keyword = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase();
  if (keyword === "begin" || (keyword === "start" && /^\s*start\s+transaction\b/i.test(sql))) {
    return "begin";
  }
  if (keyword === "commit" || keyword === "end") return "commit";
  if (keyword === "rollback" && !/^\s*rollback\s+(transaction\s+)?to\b/i.test(sql)) {
    return "rollback";
  }
  return keyword === "select" || keyword === "pragma" || keyword === "show" ? "read" : "write";
}

/**
 * The transaction state of one TypeORM driver connection. Like a single database
 * connection, every statement sent while a transaction is open joins it; the storage
 * transaction opens lazily with the first one.
 */
export class StorageSession {
  private current: PendingTransaction | undefined;

  constructor(private readonly dbStorage: DBStorage) {}

  get inTransaction(): boolean {
    return this.current !== undefined;
  }

  /**
   * `BEGIN` must not fail: TypeORM's rollback after a failed `BEGIN` corrupts its
   * transaction depth. Opening lazily reports a failure from inside the transaction.
   */
  begin(): void {
    if (this.current) throw new Error("A transaction is already open on this connection.");
    this.current = {};
  }

  /** The open transaction's executor, opening the storage transaction on first use. */
  async transaction(): Promise<DBExecutor> {
    const current = this.current!;
    const open = await (current.opened ??= openTransaction(this.dbStorage));
    return open.tx;
  }

  async end(commit: boolean): Promise<void> {
    const ending = this.current;
    this.current = undefined;
    if (!ending?.opened) return;
    if (commit) await (await ending.opened).end(true);
    // TypeORM ignores rollback failures, and one that never opened has nothing to undo.
    else await ending.opened.then((open) => open.end(false)).catch(() => undefined);
  }
}
