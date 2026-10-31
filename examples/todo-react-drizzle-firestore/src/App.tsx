import { sql } from "drizzle-orm";
import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { ACCOUNTS, useAccount, type Account } from "./account.ts";
import { todos, type Todo } from "./db/schema.ts";
import { isFirebaseConfigured } from "./firebase.ts";
import { SyncClientProvider, useLiveQuery, useSyncClient } from "./sync.ts";

/** Bound the rendered window even when the local database contains many rows. */
const VISIBLE_TODO_LIMIT = 200;
const TODO_COLLECTIONS: "todos"[] = ["todos"];

type TodoFilter = "all" | "open" | "completed";

function TodoApp({
  account,
  onAccountChange,
}: {
  account: Account;
  onAccountChange: (account: Account) => void;
}) {
  const client = useSyncClient();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [role, setRole] = useState(client.role);
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const { data, isPending } = useLiveQuery({
    collections: TODO_COLLECTIONS,
    query: (queryDb) =>
      queryDb.query.todos.findMany({
        // Relational filters reject `undefined`: leave unused fields out instead.
        where: {
          ...(filter === "all" ? {} : { completed: filter === "completed" }),
          ...(search.trim() ? { title: { like: `%${search.trim()}%` } } : {}),
        },
        orderBy: { updatedAt: "desc", id: "desc" },
        limit: VISIBLE_TODO_LIMIT,
      }),
    deps: [filter, search],
  });

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    client.startSync();
    setSyncEnabled(true);
    return () => {
      client.stopSync();
    };
  }, [client]);

  const { data: countRows } = useLiveQuery({
    collections: TODO_COLLECTIONS,
    query: (queryDb) => queryDb.select({ count: sql<number>`count(*)` }).from(todos),
  });
  const todoCount = countRows ? Number(countRows[0]?.count ?? 0) : null;

  useEffect(() => client.subscribeRole(setRole), [client]);

  const addTodo = useCallback(
    async (event: SyntheticEvent) => {
      event.preventDefault();
      const title = draft.trim();
      if (!title) return;
      await client.collections.todos.insert({
        id: crypto.randomUUID(),
        title,
        completed: false,
        updatedAt: Date.now(),
      });
      setDraft("");
    },
    [client, draft],
  );

  const toggleTodo = useCallback(
    async (todo: Todo) => {
      await client.collections.todos.update({
        id: todo.id,
        completed: !todo.completed,
        updatedAt: Date.now(),
      });
    },
    [client],
  );

  const removeTodo = useCallback(
    async (id: string) => {
      await client.collections.todos.delete(id);
    },
    [client],
  );

  const items = data ?? [];

  return (
    <main className="app">
      <header className="hero">
        <p className="brand">EzSync</p>
        <h1>Todos</h1>
        <AccountSwitcher account={account} onChange={onAccountChange} />
        <p className="lede">Local-first tasks with sql.js, Drizzle, and Firestore sync.</p>
        <p className={`sync-status ${syncEnabled && isOnline ? "online" : "offline"}`}>
          {!syncEnabled
            ? "Local-only mode — add VITE_FIREBASE_* env vars to enable sync"
            : isOnline
              ? "Firestore sync connected"
              : "Offline — sync paused until you're back online"}
        </p>
        <p className="lede" data-testid="storage-role">
          {role === "leader"
            ? "This tab holds the local database"
            : "Using the local database held by another tab"}
        </p>
        {todoCount != null && (
          <p className="lede">
            {todoCount.toLocaleString()} todos locally
            {todoCount > VISIBLE_TODO_LIMIT
              ? ` — showing the ${VISIBLE_TODO_LIMIT} most recently updated`
              : null}
          </p>
        )}
      </header>

      <form className="composer" onSubmit={addTodo}>
        <input
          aria-label="New todo"
          placeholder="What needs doing?"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">Add</button>
      </form>

      <div className="list-controls">
        <label>
          <span className="sr-only">Search todos</span>
          <input
            aria-label="Search todos"
            placeholder="Search tasks"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Filter todos</span>
          <select
            aria-label="Filter todos"
            value={filter}
            onChange={(event) => {
              const value = event.target.value;
              setFilter(value === "open" || value === "completed" ? value : "all");
            }}
          >
            <option value="all">All tasks</option>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </div>

      <section className="list" aria-live="polite">
        {isPending && items.length === 0 ? (
          <p className="empty">Loading local database…</p>
        ) : items.length === 0 ? (
          <p className="empty">
            {search.trim() || filter !== "all"
              ? "No tasks match these filters."
              : "No todos yet. Add one above."}
          </p>
        ) : (
          <ul>
            {items.map((todo) => (
              <li key={todo.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => void toggleTodo(todo)}
                  />
                  <span className={todo.completed ? "done" : undefined}>{todo.title}</span>
                </label>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void removeTodo(todo.id)}
                  aria-label={`Delete ${todo.title}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function AccountSwitcher({
  account,
  onChange,
}: {
  account: Account;
  onChange: (account: Account) => void;
}) {
  return (
    <label className="account">
      Account{" "}
      <select
        aria-label="Account"
        value={account}
        onChange={(event) => {
          const next = ACCOUNTS.find((value) => value === event.target.value);
          if (next) onChange(next);
        }}
      >
        {ACCOUNTS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Shown instead of the app when an account's database cannot open. */
class DatabaseErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("Failed to initialize the local database", error);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app">
        <p className="empty">
          Unable to open your local data. Your saved data was not replaced. Reload the app, and
          consult recovery instructions before clearing browser storage.
        </p>
      </main>
    );
  }
}

export function App() {
  const [account, setAccount] = useAccount();
  return (
    // Keyed by account: another account gets a fresh chance to open its database.
    <DatabaseErrorBoundary key={account}>
      <SyncClientProvider
        scope={account}
        fallback={
          <main className="app">
            <p className="empty">Opening {account}'s local database…</p>
          </main>
        }
      >
        <TodoApp account={account} onAccountChange={setAccount} />
      </SyncClientProvider>
    </DatabaseErrorBoundary>
  );
}
