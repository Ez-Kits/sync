import { Timestamp } from "firebase/firestore";
import { expect, test } from "vite-plus/test";
import {
  createFirestoreCollectionSyncAdapter,
  createFirestoreSyncAdapter,
  firestoreCheckpointSerializer,
} from "../src/sync-firestore.ts";
import {
  createRealtimeDBCollectionSyncAdapter,
  createRealtimeDBSyncAdapter,
  realtimeDBCheckpointSerializer,
} from "../src/sync-realtime-db.ts";

const custom = { serialize: () => "custom", deserialize: () => 0 };
const handlers = { collectionPath: "todos", createCheckpoint: () => 0 } as const;

test("firestore checkpoints keep their Timestamps through the database", () => {
  const checkpoint = { updatedAt: new Timestamp(1_700_000_000, 123), id: "a", nested: [{ n: 1 }] };
  const stored = firestoreCheckpointSerializer.serialize(checkpoint);
  const read = firestoreCheckpointSerializer.deserialize(stored);
  expect(read.updatedAt).toBeInstanceOf(Timestamp);
  expect(read.updatedAt.isEqual(checkpoint.updatedAt)).toBe(true);
  expect(read).toEqual(checkpoint);
  expect(firestoreCheckpointSerializer.deserialize('{"cursor":"plain"}')).toEqual({
    cursor: "plain",
  });
});

test("realtime database checkpoints are stored as JSON", () => {
  const stored = realtimeDBCheckpointSerializer.serialize({ updatedAt: 5, id: "a" });
  expect(stored).toBe('{"updatedAt":5,"id":"a"}');
  expect(realtimeDBCheckpointSerializer.deserialize(stored)).toEqual({ updatedAt: 5, id: "a" });
});

test("firestore adapters use the default checkpoint serializer unless given one", () => {
  const db = {} as never;
  const resolveRemoteId = () => "id";
  expect(createFirestoreSyncAdapter({ db, collections: [] }).checkpointSerializer).toBe(
    firestoreCheckpointSerializer,
  );
  expect(
    createFirestoreSyncAdapter({ db, collections: [], checkpointSerializer: custom })
      .checkpointSerializer,
  ).toBe(custom);
  expect(
    createFirestoreCollectionSyncAdapter({ db, ...handlers, resolveRemoteId }).checkpointSerializer,
  ).toBe(firestoreCheckpointSerializer);
  expect(
    createFirestoreCollectionSyncAdapter({
      db,
      ...handlers,
      resolveRemoteId,
      checkpointSerializer: custom,
    }).checkpointSerializer,
  ).toBe(custom);
});

test("realtime database adapters use the default checkpoint serializer unless given one", () => {
  const db = {} as never;
  const resolveRemoteId = () => "id";
  expect(createRealtimeDBSyncAdapter({ db, collections: [] }).checkpointSerializer).toBe(
    realtimeDBCheckpointSerializer,
  );
  expect(
    createRealtimeDBSyncAdapter({ db, collections: [], checkpointSerializer: custom })
      .checkpointSerializer,
  ).toBe(custom);
  expect(
    createRealtimeDBCollectionSyncAdapter({ db, ...handlers, resolveRemoteId })
      .checkpointSerializer,
  ).toBe(realtimeDBCheckpointSerializer);
  expect(
    createRealtimeDBCollectionSyncAdapter({
      db,
      ...handlers,
      resolveRemoteId,
      checkpointSerializer: custom,
    }).checkpointSerializer,
  ).toBe(custom);
});
