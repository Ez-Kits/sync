import { desc, sql } from "drizzle-orm";
import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { db } from "./db/index.ts";
import { todos, type Todo } from "./db/schema.ts";
import { isFirebaseConfigured } from "./firebase.ts";
import { SyncClientProvider, useLiveQuery, useSyncClient } from "./sync.ts";

/** Keep the demo UI responsive after the one-time 1M seed. */
const VISIBLE_TODO_LIMIT = 200;

function TodoApp() {
  const client = useSyncClient();
  const [draft, setDraft] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [todoCount, setTodoCount] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const { data, isPending } = useLiveQuery({
    collections: useMemo(() => ["todos"], []),
    query: useCallback(
      (queryDb) => queryDb.select().from(todos).orderBy(desc(todos.id)).limit(VISIBLE_TODO_LIMIT),
      [],
    ),
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

  useEffect(() => {
    let cancelled = false;
    void db
      .select({ count: sql<number>`count(*)` })
      .from(todos)
      .then((rows) => {
        if (!cancelled) {
          setTodoCount(Number(rows[0]?.count ?? 0));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

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
        <p className="lede">Local-first tasks with sql.js, Drizzle, and Firestore sync.</p>
        <p className={`sync-status ${syncEnabled && isOnline ? "online" : "offline"}`}>
          {!syncEnabled
            ? "Local-only mode — add VITE_FIREBASE_* env vars to enable sync"
            : isOnline
              ? "Firestore sync connected"
              : "Offline — sync paused until you're back online"}
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

      <section className="list" aria-live="polite">
        {isPending && items.length === 0 ? (
          <p className="empty">Loading local database…</p>
        ) : items.length === 0 ? (
          <p className="empty">No todos yet. Add one above.</p>
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

export function App() {
  return (
    <SyncClientProvider>
      <TodoApp />
    </SyncClientProvider>
  );
}
