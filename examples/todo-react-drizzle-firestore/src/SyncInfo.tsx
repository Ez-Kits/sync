import type { PullState, SyncStatusEvent } from "@ez-kits/sync-client-core";
import { useEffect, useState } from "react";
import { todoVfs } from "./db/vfs.ts";
import { useSyncClient } from "./sync.ts";

/** How many status changes the panel keeps. */
const STATUS_HISTORY_LIMIT = 20;

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function formatTime(time: number | undefined): string {
  return time === undefined ? "never" : new Date(time).toLocaleTimeString();
}

function formatFlag(flag: boolean | undefined): string {
  return flag === undefined ? "unknown" : flag ? "yes" : "no";
}

function Field({ name, testId, value }: { name: string; testId?: string; value: string | number }) {
  return (
    <div className="sync-field">
      <dt>{name}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

/** Everything the sync client reports: status, role, the outbox and the pull. */
export function SyncInfo() {
  const client = useSyncClient();
  const [history, setHistory] = useState<SyncStatusEvent[]>([]);
  const [role, setRole] = useState(client.role);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof client.getPendingWrites>>>();
  const [pullState, setPullState] = useState<PullState>(client.getPullState);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    setHistory([]);
    return client.subscribeStatus((event) =>
      setHistory((events) => [event, ...events].slice(0, STATUS_HISTORY_LIMIT)),
    );
  }, [client]);
  useEffect(() => client.subscribeRole(setRole), [client]);
  useEffect(() => client.subscribePendingWrites(setPending), [client]);
  useEffect(() => client.subscribePullState(setPullState), [client]);
  useEffect(() => {
    const onChange = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
    };
  }, []);

  const current = history[0];
  const status = current?.status ?? "stopped";

  return (
    <section className="sync-info" aria-label="Sync info">
      <div className="sync-info-header">
        <h2>Sync</h2>
        <span className={`sync-badge ${status}`} data-testid="sync-status">
          {status}
        </span>
        {status === "stopped" ? (
          <button type="button" className="ghost" onClick={() => client.startSync()}>
            Start
          </button>
        ) : (
          <button type="button" className="ghost" onClick={() => client.stopSync()}>
            Stop
          </button>
        )}
      </div>

      {current?.error !== undefined && (
        <p className="sync-error" data-testid="sync-error">
          {describeError(current.error)}
        </p>
      )}

      <dl>
        <Field name="Since" value={formatTime(current?.changedAt)} />
        <Field name="Role" value={role} />
        <Field name="Browser" value={isOnline ? "online" : "offline"} />
        <Field
          name="Local database"
          testId="local-storage"
          value={`wa-sqlite on ${todoVfs === "opfs" ? "OPFS" : "IndexedDB (OPFS refused)"}`}
        />
        <Field name="Backend" value={`Firestore emulator at ${location.host}`} />
      </dl>

      <h3>Waiting to push</h3>
      <dl>
        <Field name="Pending" testId="pending-writes" value={pending?.total ?? "reading…"} />
        <Field name="Refused" testId="rejected-writes" value={pending?.rejected ?? "reading…"} />
        {Object.entries(pending?.byCollection ?? {}).map(([collection, count]) => (
          <Field key={collection} name={collection} value={count as number} />
        ))}
      </dl>
      {Boolean(pending?.rejected) && (
        <button type="button" className="ghost" onClick={() => client.retryRejectedPushes()}>
          Retry refused writes
        </button>
      )}

      {Object.entries(pullState).map(([collection, pull]) => (
        <div key={collection}>
          <h3>Pulling {collection}</h3>
          <dl>
            <Field name="Local data ready" value={formatFlag(pull.available)} />
            <Field
              name="Caught up"
              testId={`caught-up-${collection}`}
              value={formatFlag(pull.caughtUp)}
            />
            <Field name="Backend has data" value={formatFlag(pull.hasRemoteData)} />
            <Field
              name="Progress"
              value={`${pull.progress.pulled} / ${pull.progress.total ?? "?"}`}
            />
            <Field name="Last pull" value={formatTime(pull.lastPulledAt)} />
          </dl>
        </div>
      ))}

      <details>
        <summary>Status history</summary>
        <ol className="sync-history">
          {history.map((event, index) => (
            <li key={history.length - index}>
              {formatTime(event.changedAt)} {event.status}
              {event.error !== undefined && ` (${describeError(event.error)})`}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
