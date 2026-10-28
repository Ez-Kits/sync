import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { Like } from "typeorm";
import { Todo } from "./db/schema.ts";
import { isFirebaseConfigured } from "./firebase.ts";
import { SyncClientProvider, useLiveQuery, useSyncClient } from "./sync.ts";

/** Bound the rendered window even when the local database contains many rows. */
const VISIBLE_TODO_LIMIT = 200;
const TODO_COLLECTIONS: "todos"[] = ["todos"];

type TodoFilter = "all" | "open" | "completed";

function TodoApp() {
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
    query: useCallback(
      (queryDb) =>
        queryDb.repositories.todos.find({
          // TypeORM matches `undefined` fields too: leave unused fields out instead.
          where: {
            ...(filter === "all" ? {} : { completed: filter === "completed" }),
            ...(search.trim() ? { title: Like(`%${search.trim()}%`) } : {}),
          },
          order: { updatedAt: "DESC", id: "DESC" },
          take: VISIBLE_TODO_LIMIT,
        }),
      [filter, search],
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

  const { data: todoCount = null } = useLiveQuery({
    collections: TODO_COLLECTIONS,
    query: useCallback((queryDb) => queryDb.repositories.todos.count(), []),
  });

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
        <p className="lede">Local-first tasks with sql.js, TypeORM, and Firestore sync.</p>
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

export function App() {
  return (
    <SyncClientProvider>
      <TodoApp />
    </SyncClientProvider>
  );
}
