import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { PushRejectedError } from "@ez-kits/sync-client-core";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously } from "firebase/auth";
import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  get,
  set,
  query as queryDatabase,
  orderByChild,
  startAfter as startAfterDatabase,
} from "firebase/database";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  orderBy,
  startAfter,
} from "firebase/firestore";
import { createFirestoreCollectionSyncAdapter } from "../src/firestore";
import { createRealtimeDBCollectionSyncAdapter } from "../src/realtime-db";

const runIfEmulator = test.skipIf(process.env.EZSYNC_FIREBASE_EMULATOR !== "1");
const app = initializeApp(
  {
    apiKey: "emulator-test-key",
    projectId: "demo-ezsync",
    databaseURL: "https://demo-ezsync-default-rtdb.firebaseio.com",
  },
  `ezsync-${crypto.randomUUID()}`,
);
const auth = getAuth(app);
const firestore = getFirestore(app);
const database = getDatabase(app);
let userId = "emulator-user";
if (process.env.EZSYNC_FIREBASE_EMULATOR === "1") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  connectDatabaseEmulator(database, "127.0.0.1", 9000);
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
      resolveDocumentId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
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
      resolveDocumentId: (event: any) => String(event.data.id),
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
      resolveRecordId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
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
      resolveRecordId: (event: any) => String(event.data.id),
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
      buildRealtimePullQuery: ({ db, collectionPath, checkpoint }: any) => {
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
      resolveRecordId: (event: any) => String(event.data.id),
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
