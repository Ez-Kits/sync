import { afterAll, expect, test, vi } from "vite-plus/test";
import { deleteApp, initializeApp } from "firebase/app";
import { getDatabase, connectDatabaseEmulator, ref, get, set } from "firebase/database";
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } from "firebase/firestore";
import { createFirestoreCollectionSyncAdapter } from "../src/firestore";
import { createRealtimeDBCollectionSyncAdapter } from "../src/realtime-db";

const runIfEmulator = test.skipIf(process.env.EZSYNC_FIREBASE_EMULATOR !== "1");
const app = initializeApp(
  { projectId: "demo-ezsync", databaseURL: "https://demo-ezsync-default-rtdb.firebaseio.com" },
  `ezsync-${crypto.randomUUID()}`,
);
const firestore = getFirestore(app);
const database = getDatabase(app);
if (process.env.EZSYNC_FIREBASE_EMULATOR === "1") {
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  connectDatabaseEmulator(database, "127.0.0.1", 9000);
}

afterAll(async () => deleteApp(app));

runIfEmulator(
  "Firestore adapter pushes to the emulator and pulls persisted snapshots",
  async () => {
    const path = `integration-${crypto.randomUUID()}`;
    const adapter = createFirestoreCollectionSyncAdapter({
      db: firestore,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => "cp",
      resolveDocumentId: (event: any) => String(event.data.id),
    } as never);
    const committed = vi.fn();
    await adapter.push({
      events: [{ type: "create", collection: "todos", data: { id: "one", title: "persisted" } }],
      commitChanges: committed,
    } as never);
    expect((await getDoc(doc(firestore, path, "one"))).data()).toEqual({
      id: "one",
      title: "persisted",
    });
    let cleanup: (() => void) | undefined;
    const pulled = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Firestore emulator pull timed out")), 5_000);
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
    await setDoc(doc(firestore, path, "two"), { id: "two", title: "pulled" });
    await expect(pulled).resolves.toMatchObject({ data: { id: "two", title: "pulled" } });
  },
);

runIfEmulator(
  "Realtime Database adapter merges records and pulls emulator child events",
  async () => {
    const path = `integration-${crypto.randomUUID()}`;
    const adapter = createRealtimeDBCollectionSyncAdapter({
      db: database,
      collectionName: "todos",
      collectionPath: path,
      createCheckpoint: () => "cp",
      resolveRecordId: (event: any) => String(event.data.id),
    } as never);
    await adapter.push({
      events: [{ type: "create", collection: "todos", data: { id: "one", title: "persisted" } }],
      commitChanges: () => {},
    } as never);
    expect((await get(ref(database, `${path}/one`))).val()).toEqual({
      id: "one",
      title: "persisted",
    });
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
