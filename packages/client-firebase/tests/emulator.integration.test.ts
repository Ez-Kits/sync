import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { ChangeBus, GlobalSyncHandler, PushRejectedError } from "@ez-kits/sync-client-core";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously } from "firebase/auth";
import {
  getDatabase,
  connectDatabaseEmulator,
  goOffline,
  goOnline,
  ref,
  get,
  set,
  update,
  query as queryDatabase,
  orderByChild,
  startAfter as startAfterDatabase,
} from "firebase/database";
import {
  getFirestore,
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  setDoc,
  writeBatch,
  orderBy,
  startAfter,
} from "firebase/firestore";
import { createFirestoreCollectionSyncAdapter } from "../src/firestore";
import { createRealtimeDBCollectionSyncAdapter } from "../src/realtime-db";

const runIfEmulator = test.skipIf(process.env.EZSYNC_FIREBASE_EMULATOR !== "1");
const firebaseOptions = {
  apiKey: "emulator-test-key",
  projectId: "demo-ezsync",
  databaseURL: "https://demo-ezsync-default-rtdb.firebaseio.com",
};
// `firebase emulators:exec` sets these; the defaults are firebase.json's ports.
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const [firestoreHost, firestorePort] = (
  process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080"
).split(":");
const [databaseHost, databasePort] = (
  process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? "127.0.0.1:9000"
).split(":");
const app = initializeApp(firebaseOptions, `ezsync-${crypto.randomUUID()}`);
const auth = getAuth(app);
const firestore = getFirestore(app);
const database = getDatabase(app);
let userId = "emulator-user";
if (process.env.EZSYNC_FIREBASE_EMULATOR === "1") {
  connectAuthEmulator(auth, `http://${authEmulator}`, { disableWarnings: true });
  connectFirestoreEmulator(firestore, firestoreHost!, Number(firestorePort));
  connectDatabaseEmulator(database, databaseHost!, Number(databasePort));
}

beforeAll(async () => {
  if (process.env.EZSYNC_FIREBASE_EMULATOR === "1") {
    const credential = await signInAnonymously(auth);
    userId = credential.user.uid;
  }
});

afterAll(async () => deleteApp(app));

runIfEmulator(
  "Firestore push retries are idempotent, tombstones persist, and denied writes are not acknowledged",
  async () => {
    const path = `users/${userId}/integration-${crypto.randomUUID()}`;
    const adapter = createFirestoreCollectionSyncAdapter({
      db: firestore,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => "cp",
      resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
    } as never);
    const createEvent = {
      type: "create",
      collection: "todos",
      data: { id: "one", title: "persisted" },
    };
    const acknowledged = vi.fn();
    await adapter.push({ events: [createEvent], commitChanges: acknowledged } as never);
    await adapter.push({ events: [createEvent], commitChanges: acknowledged } as never);
    expect(acknowledged).toHaveBeenCalledTimes(2);
    expect((await getDoc(doc(firestore, path, "one"))).data()).toEqual({
      id: "one",
      title: "persisted",
    });
    await adapter.push({
      events: [{ type: "update", collection: "todos", data: { id: "one", title: "updated" } }],
      commitChanges: acknowledged,
    } as never);
    expect((await getDoc(doc(firestore, path, "one"))).data()).toMatchObject({ title: "updated" });

    await adapter.push({
      events: [{ type: "delete", collection: "todos", id: "one" }],
      commitChanges: acknowledged,
    } as never);
    expect((await getDoc(doc(firestore, path, "one"))).data()).toMatchObject({ deleted: true });

    const deniedPath = `users/another-user/integration-${crypto.randomUUID()}`;
    const denied = createFirestoreCollectionSyncAdapter({
      db: firestore,
      collectionName: "todos",
      collectionPath: deniedPath,
      createCheckpoint: () => "cp",
      resolveRemoteId: (event: any) => String(event.data.id),
    } as never);
    const notAcknowledged = vi.fn();
    await expect(
      denied.push({
        events: [{ type: "create", collection: "todos", data: { id: "denied" } }],
        commitChanges: notAcknowledged,
      } as never),
      // Permanent: core parks it instead of retrying it ahead of later writes.
    ).rejects.toBeInstanceOf(PushRejectedError);
    expect(notAcknowledged).not.toHaveBeenCalled();
    await expect(getDoc(doc(firestore, deniedPath, "denied"))).rejects.toThrow();
  },
);

runIfEmulator(
  "Firestore checkpoint resumes across equal cursors and sees records whose cursor advances",
  async () => {
    const path = `users/${userId}/integration-${crypto.randomUUID()}`;
    await Promise.all([
      setDoc(doc(firestore, path, "a"), { id: "a", cursor: 1, title: "checkpoint" }),
      setDoc(doc(firestore, path, "b"), { id: "b", cursor: 1, title: "equal cursor" }),
      setDoc(doc(firestore, path, "c"), { id: "c", cursor: 0, title: "later update" }),
    ]);
    const adapter = createFirestoreCollectionSyncAdapter({
      db: firestore,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => ({ cursor: 0, id: "" }),
      buildPullQueryConstraints: ({ checkpoint }: any) =>
        checkpoint
          ? [orderBy("cursor"), orderBy("id"), startAfter(checkpoint.cursor, checkpoint.id)]
          : [orderBy("cursor"), orderBy("id")],
      createPullCheckpoint: ({ snapshot }: any) => {
        const last = snapshot.docs.at(-1);
        return last ? { cursor: last.data().cursor, id: last.id } : { cursor: 0, id: "" };
      },
    } as never);
    const received = new Set<string>();
    let cleanup: (() => void) | undefined;
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Firestore checkpoint pull timed out")),
        5_000,
      );
      cleanup = adapter.pull({
        checkpoint: { todos: { cursor: 1, id: "a" } },
        commitChanges: ({ changes }: { changes: any[] }) => {
          for (const change of changes) received.add(change.data.id);
          if (received.has("b") && received.has("c")) {
            clearTimeout(timer);
            cleanup?.();
            resolve();
          }
        },
      } as never) as (() => void) | undefined;
    });
    await setDoc(doc(firestore, path, "c"), { id: "c", cursor: 2, title: "advanced" });
    await expect(observed).resolves.toBeUndefined();
    expect(received).toEqual(new Set(["b", "c"]));
  },
);

runIfEmulator(
  "Realtime Database pushes are retry-safe, propagate tombstones, and enforce user-scoped rules",
  async () => {
    const path = `users/${userId}/integration-${crypto.randomUUID()}`;
    const adapter = createRealtimeDBCollectionSyncAdapter({
      db: database,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => "cp",
      resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
    } as never);
    const createEvent = {
      type: "create",
      collection: "todos",
      data: { id: "one", title: "persisted" },
    };
    const acknowledged = vi.fn();
    await adapter.push({ events: [createEvent], commitChanges: acknowledged } as never);
    await adapter.push({ events: [createEvent], commitChanges: acknowledged } as never);
    expect(acknowledged).toHaveBeenCalledTimes(2);
    expect((await get(ref(database, `${path}/one`))).val()).toEqual({
      id: "one",
      title: "persisted",
    });
    await adapter.push({
      events: [{ type: "update", collection: "todos", data: { id: "one", title: "updated" } }],
      commitChanges: acknowledged,
    } as never);
    expect((await get(ref(database, `${path}/one`))).val()).toMatchObject({ title: "updated" });
    await adapter.push({
      events: [{ type: "delete", collection: "todos", id: "one" }],
      commitChanges: acknowledged,
    } as never);
    expect((await get(ref(database, `${path}/one`))).val()).toMatchObject({ deleted: true });

    const denied = createRealtimeDBCollectionSyncAdapter({
      db: database,
      collectionName: "todos",
      collectionPath: `users/another-user/integration-${crypto.randomUUID()}`,
      createCheckpoint: () => "cp",
      resolveRemoteId: (event: any) => String(event.data.id),
    } as never);
    const notAcknowledged = vi.fn();
    await expect(
      denied.push({
        events: [{ type: "create", collection: "todos", data: { id: "denied" } }],
        commitChanges: notAcknowledged,
      } as never),
      // Permanent: core parks it instead of retrying it ahead of later writes.
    ).rejects.toBeInstanceOf(PushRejectedError);
    expect(notAcknowledged).not.toHaveBeenCalled();
    await expect(
      get(ref(database, "users/another-user/integration-denied/denied")),
    ).rejects.toThrow();
  },
);

runIfEmulator(
  "Realtime Database checkpoint resumes after equal cursor keys and observes cursor advances",
  async () => {
    const path = `users/${userId}/integration-${crypto.randomUUID()}`;
    await Promise.all([
      set(ref(database, `${path}/a`), { id: "a", cursor: 1, title: "checkpoint" }),
      set(ref(database, `${path}/b`), { id: "b", cursor: 1, title: "equal cursor" }),
      set(ref(database, `${path}/c`), { id: "c", cursor: 0, title: "later update" }),
    ]);
    const adapter = createRealtimeDBCollectionSyncAdapter({
      db: database,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => ({ cursor: 0, id: "" }),
      buildPullQuery: ({ db, collectionPath, checkpoint }: any) => {
        const target = ref(db, collectionPath);
        return checkpoint
          ? queryDatabase(
              target,
              orderByChild("cursor"),
              startAfterDatabase(checkpoint.cursor, checkpoint.id),
            )
          : queryDatabase(target, orderByChild("cursor"));
      },
      createPullCheckpoint: ({ snapshot }: any) => ({
        cursor: snapshot.child("cursor").val(),
        id: snapshot.key,
      }),
    } as never);
    const received = new Set<string>();
    let cleanup: (() => void) | undefined;
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Realtime Database checkpoint pull timed out")),
        5_000,
      );
      cleanup = adapter.pull({
        checkpoint: { todos: { cursor: 1, id: "a" } },
        commitChanges: ({ changes }: { changes: any[] }) => {
          for (const change of changes) received.add(change.data.id);
          if (received.has("b") && received.has("c")) {
            clearTimeout(timer);
            cleanup?.();
            resolve();
          }
        },
      } as never) as (() => void) | undefined;
    });
    await set(ref(database, `${path}/c`), { id: "c", cursor: 2, title: "advanced" });
    await expect(observed).resolves.toBeUndefined();
    expect(received).toEqual(new Set(["b", "c"]));
  },
);

runIfEmulator(
  "Realtime Database adapter pulls emulator child events for the authenticated user",
  async () => {
    const path = `users/${userId}/integration-${crypto.randomUUID()}`;
    const adapter = createRealtimeDBCollectionSyncAdapter({
      db: database,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => "cp",
      resolveRemoteId: (event: any) => String(event.data.id),
    } as never);
    let cleanup: (() => void) | undefined;
    const pulled = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Realtime Database emulator pull timed out")),
        5_000,
      );
      cleanup = adapter.pull({
        commitChanges: ({ changes }: { changes: any[] }) => {
          const create = changes.find((change: any) => change.type === "create");
          if (create) {
            clearTimeout(timer);
            cleanup?.();
            resolve(create);
          }
        },
      } as never) as (() => void) | undefined;
    });
    await set(ref(database, `${path}/two`), { id: "two", title: "pulled" });
    await expect(pulled).resolves.toMatchObject({ data: { id: "two", title: "pulled" } });
  },
);

/** A device's view of its backend: an adapter factory, its connection, the server's copy. */
const backends = {
  Firestore: (deviceApp: FirebaseApp, path: string) => {
    const db = getFirestore(deviceApp);
    connectFirestoreEmulator(db, firestoreHost!, Number(firestorePort));
    return {
      db,
      createAdapter: createFirestoreCollectionSyncAdapter as (config: never) => unknown,
      goOffline: () => disableNetwork(db),
      goOnline: () => enableNetwork(db),
      read: async (id: string) => (await getDoc(doc(db, path, id))).data(),
    };
  },
  "Realtime Database": (deviceApp: FirebaseApp, path: string) => {
    const db = getDatabase(deviceApp);
    connectDatabaseEmulator(db, databaseHost!, Number(databasePort));
    return {
      db,
      createAdapter: createRealtimeDBCollectionSyncAdapter as (config: never) => unknown,
      goOffline: () => goOffline(db),
      goOnline: () => goOnline(db),
      read: async (id: string) => (await get(ref(db, `${path}/${id}`))).val(),
    };
  },
};
type BackendName = keyof typeof backends;
const backendNames = Object.keys(backends) as BackendName[];

/** One device: its own backend client and sign-in, a sync handler, and in-memory tables. */
async function createDevice(backendName: BackendName, path: string, resolveConflict?: unknown) {
  const deviceApp = initializeApp(firebaseOptions, `device-${crypto.randomUUID()}`);
  const deviceAuth = getAuth(deviceApp);
  connectAuthEmulator(deviceAuth, `http://${authEmulator}`, { disableWarnings: true });
  await signInAnonymously(deviceAuth);
  const backend = backends[backendName](deviceApp, path);

  const rows = new Map<string, Record<string, unknown>>();
  const key = ({ collection, recordId }: any) => `${collection}\0${recordId}`;
  const inScope = (item: any, scope?: any) =>
    scope === undefined ||
    (item.collection === scope.collection && item.recordId === scope.recordId);
  const outbox = new Map<string, any>();
  const dirty = new Map<string, any>();
  const skipped = new Map<string, any>();
  const revisions = new Map<string, number>();
  const store = {
    appendEvents: async (events: any[]) => {
      for (const event of events) outbox.set(event.id, event);
    },
    getPendingEvents: async (scope?: any) =>
      [...outbox.values()].filter((event) => inScope(event, scope)),
    deleteEvents: async (ids: string[]) => {
      for (const id of ids) outbox.delete(id);
    },
    upsertDirtyRecord: async (record: any) => void dirty.set(key(record), record),
    removeDirtyRecords: async (keys: any[]) => {
      for (const item of keys) dirty.delete(key(item));
    },
    getDirtyRecords: async (scope?: any) =>
      [...dirty.values()].filter((record) => inScope(record, scope)),
    getSkippedRemoteEvents: async (scope?: any) =>
      [...skipped.values()].filter((entry) => inScope(entry, scope)),
    upsertSkippedRemoteEvent: async (entry: any) =>
      void skipped.set(key(entry), structuredClone(entry)),
    removeSkippedRemoteEvents: async (keys: any[]) => {
      for (const item of keys) skipped.delete(key(item));
    },
    getRevision: async (item: any) => revisions.get(key(item)),
    upsertRevision: async (entry: any) => void revisions.set(key(entry), entry.rev),
    removeRevisions: async () => {},
  };
  const tables = {
    insert: async (_name: string, row: any) => void rows.set(String(row.id), row),
    update: async (_name: string, row: any) =>
      void rows.set(String(row.id), { ...rows.get(String(row.id)), ...row }),
    delete: async (_name: string, id: unknown) => void rows.delete(String(id)),
    get: async (_name: string, id: unknown) => rows.get(String(id)),
    getOptional: async (_name: string, id: unknown) => rows.get(String(id)),
    transaction: async (fn: any) => fn(tables, { operations: tables, native: undefined }),
  };
  const applied: any[] = [];
  const handler = new GlobalSyncHandler({
    collections: [{ name: "todos", primaryField: "id", adapterConfig: {} }],
    syncAdapter: backend.createAdapter({
      db: backend.db,
      collectionName: "todos",
      collectionPath: path,
      revisionField: "rev",
      createCheckpoint: () => "cp",
      resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
    } as never),
    db: tables,
    changeBus: new ChangeBus<any>(),
    checkpointStorage: { getCheckpoint: async () => undefined, saveCheckpoint: async () => {} },
    localChangeStore: store,
    resolveConflict,
    onRemoteChangesCommitted: (changes: any[]) => applied.push(...changes),
  } as never);
  handler.start();
  devices.push(async () => {
    handler.stop();
    await deleteApp(deviceApp);
  });

  return {
    db: backend.db as any,
    goOffline: backend.goOffline,
    goOnline: backend.goOnline,
    read: backend.read,
    rows,
    applied,
    pending: () => outbox.size,
    /** A local write, committed like the client's: row, outbox event and dirty record. */
    async write(type: "create" | "update" | "delete", id: string, data: object = {}) {
      const recordId = id;
      if (type === "delete") rows.delete(id);
      else rows.set(id, { ...rows.get(id), id, ...data });
      await store.appendEvents([
        {
          id: crypto.randomUUID(),
          type,
          collection: "todos",
          recordId,
          data: { id, ...data },
          createdAt: Date.now(),
        },
      ]);
      await store.upsertDirtyRecord({
        collection: "todos",
        recordId,
        state: type === "delete" ? "deleted" : "dirty",
        updatedAt: Date.now(),
      });
      handler.notifyOutboxChanged();
    },
  };
}

const devices: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((close) => close()));
});

const synced = { timeout: 15_000, interval: 25 };
const quietPeriod = () => new Promise((resolve) => setTimeout(resolve, 300));
const newRevisionedPath = () => `revisioned/${crypto.randomUUID()}/todos`;

for (const backendName of backendNames) {
  for (const [decision, resolve, expected] of [
    ["remote", () => "remote", { title: "base", note: "from a" }],
    ["local", () => "local", { title: "from b", note: "from a" }],
    [
      "{ data }",
      ({ remote }: any) => ({ data: { ...remote.data, title: "merged" } }),
      { title: "merged", note: "from a" },
    ],
  ] as const) {
    runIfEmulator(
      `${backendName}: two devices writing one record reach the resolver, and ${decision} converges everywhere`,
      async () => {
        const path = newRevisionedPath();
        const resolver = vi.fn(resolve);
        const a = await createDevice(backendName, path);
        const b = await createDevice(backendName, path, resolver);
        await a.write("create", "t", { title: "base", note: "base" });
        await vi.waitFor(() => {
          expect(a.pending()).toBe(0);
          expect(b.rows.get("t")).toMatchObject({ title: "base" });
        }, synced);

        await b.goOffline();
        await b.write("update", "t", { title: "from b" });
        await a.write("update", "t", { note: "from a" });
        await vi.waitFor(() => expect(a.pending()).toBe(0), synced);
        await b.goOnline();

        const row = { id: "t", ...expected };
        await vi.waitFor(async () => {
          expect(resolver).toHaveBeenCalled();
          expect(b.pending()).toBe(0);
          expect(a.rows.get("t")).toEqual(row);
          expect(b.rows.get("t")).toEqual(row);
          expect(await a.read("t")).toEqual({ ...row, rev: expect.any(Number) });
        }, synced);
        expect(resolver.mock.calls[0]![0]).toMatchObject({
          remote: { type: "update", data: { note: "from a" } },
          local: { title: "from b" },
        });
      },
      30_000,
    );
  }

  runIfEmulator(
    `${backendName}: echoes of a device's own writes never revert a newer local write`,
    async () => {
      const device = await createDevice(backendName, newRevisionedPath());
      await device.write("create", "t", { title: "v1" });
      await device.write("update", "t", { title: "v2" });
      await device.write("update", "t", { title: "v3" });
      await vi.waitFor(() => expect(device.pending()).toBe(0), synced);
      await device.write("update", "t", { title: "v4" });
      await vi.waitFor(() => expect(device.pending()).toBe(0), synced);
      await quietPeriod();

      expect(device.rows.get("t")).toEqual({ id: "t", title: "v4" });
      expect(device.applied).toEqual([]);
      expect(await device.read("t")).toEqual({ id: "t", title: "v4", rev: 4 });
    },
    30_000,
  );

  runIfEmulator(
    `${backendName}: a stale echo after a local delete leaves the row deleted`,
    async () => {
      const device = await createDevice(backendName, newRevisionedPath());
      await device.write("create", "t", { title: "v1" });
      await device.write("delete", "t");
      await vi.waitFor(() => expect(device.pending()).toBe(0), synced);
      await quietPeriod();

      expect(device.rows.has("t")).toBe(false);
      expect(device.applied).toEqual([]);
      expect(await device.read("t")).toMatchObject({ deleted: true, rev: 2 });
    },
    30_000,
  );
}

runIfEmulator(
  "Firestore rules refuse a write that does not follow the stored revision",
  async () => {
    const path = newRevisionedPath();
    const device = await createDevice("Firestore", path);
    const write = (rev: number) => setDoc(doc(device.db, path, "t"), { id: "t", rev });
    await expect(write(5)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(write(1)).resolves.toBeUndefined();
    await expect(write(1)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(write(3)).rejects.toMatchObject({ code: "permission-denied" });
    await expect(write(2)).resolves.toBeUndefined();

    // Why a batch holds one revisioned write per document: rules check each against the
    // document before the batch, so the second of a record's writes is refused.
    const batch = writeBatch(device.db);
    batch.set(doc(device.db, path, "t"), { id: "t", rev: 3 });
    batch.set(doc(device.db, path, "t"), { id: "t", rev: 4 });
    await expect(batch.commit()).rejects.toMatchObject({ code: "permission-denied" });
  },
  30_000,
);

runIfEmulator(
  "Realtime Database rules refuse a write that does not follow the stored revision",
  async () => {
    const path = newRevisionedPath();
    const device = await createDevice("Realtime Database", path);
    const record = `${path}/t`;
    const denied = { code: "PERMISSION_DENIED" };
    const write = (rev: number) => set(ref(device.db, record), { id: "t", rev });
    await expect(write(5)).rejects.toMatchObject(denied);
    await expect(write(1)).resolves.toBeUndefined();
    await expect(write(1)).rejects.toMatchObject(denied);
    await expect(write(3)).rejects.toMatchObject(denied);
    await expect(write(2)).resolves.toBeUndefined();

    // Field writes, as updates and tombstones are pushed: the check holds below the record too.
    const merge = (fields: object) => update(ref(device.db, record), fields);
    await expect(merge({ title: "no revision" })).rejects.toMatchObject(denied);
    await expect(merge({ title: "skipped", rev: 4 })).rejects.toMatchObject(denied);
    await expect(merge({ title: "next", rev: 3 })).resolves.toBeUndefined();
  },
  30_000,
);
