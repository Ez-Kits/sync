import { DBStorageClosedError } from "./errors";
import { TxScheduler } from "./tx-scheduler";
import type {
  DBDialect,
  DBEngine,
  DBExecutor,
  DBQuery,
  DBQueryResult,
  DBStorage,
  OpenDBEngineContext,
} from "./types";

const OWNER = "local";

export interface LocalDBStorageOptions {
  dialect: DBDialect;
  key?: string;
  /** Open the engine in this context. */
  open(context: OpenDBEngineContext): DBEngine | Promise<DBEngine>;
  /** Idle time after which an open transaction is rolled back. Defaults to 10 seconds. */
  transactionTimeoutMs?: number;
}

/**
 * A {@link DBStorage} whose engine runs in this context, which always leads. Use it for
 * single-context apps, servers and tests, or engines that are already shared across tabs.
 */
export function createLocalDBStorage(options: LocalDBStorageOptions): DBStorage {
  const controller = new AbortController();
  const scheduler = Promise.resolve()
    .then(() => options.open({ signal: controller.signal }))
    .then(
      (engine) => new TxScheduler(engine, { transactionTimeoutMs: options.transactionTimeoutMs }),
    );
  const ready = scheduler.then(() => undefined);
  ready.catch(() => undefined);
  let closed: Promise<void> | undefined;
  const use = <T>(task: (scheduler: TxScheduler) => Promise<T>): Promise<T> =>
    closed ? Promise.reject(new DBStorageClosedError()) : scheduler.then(task);

  return {
    dialect: options.dialect,
    key: options.key ?? "default",
    ready,
    role: "leader",
    onRoleChange: () => () => undefined,
    onInvalidate: () => () => undefined,
    onError: () => () => undefined,
    // This context owns every transaction, so its other statements join an open one.
    exec: (query: DBQuery): Promise<DBQueryResult> => use((s) => s.exec(query, undefined, OWNER)),
    transaction: <T>(fn: (tx: DBExecutor) => Promise<T>): Promise<T> =>
      use(async (s) => {
        const txId = await s.begin(OWNER);
        let result: T;
        try {
          result = await fn({ exec: (query) => s.exec(query, txId) });
        } catch (error) {
          await s.rollback(txId).catch(() => undefined);
          throw error;
        }
        await s.commit(txId);
        return result;
      }),
    close: () => {
      closed ??= (async () => {
        controller.abort();
        const opened = await scheduler.catch(() => undefined);
        await opened?.close();
      })();
      return closed;
    },
  };
}
