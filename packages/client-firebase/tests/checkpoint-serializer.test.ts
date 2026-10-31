import { expect, test } from "vite-plus/test";
import {
  createFirestoreCollectionSyncAdapter,
  createFirestoreSyncAdapter,
} from "../src/sync-firestore.ts";
import {
  createRealtimeDBCollectionSyncAdapter,
  createRealtimeDBSyncAdapter,
} from "../src/sync-realtime-db.ts";

const custom = { serialize: () => "custom", deserialize: () => 0 };
const handlers = { collectionPath: "todos", createCheckpoint: () => 0 } as const;
const db = {} as never;
const resolveRemoteId = () => "id";

test("firestore adapters leave checkpoints to the client's JSON unless given a serializer", () => {
  expect(createFirestoreSyncAdapter({ db, collections: [] }).checkpointSerializer).toBeUndefined();
  expect(
    createFirestoreSyncAdapter({ db, collections: [], checkpointSerializer: custom })
      .checkpointSerializer,
  ).toBe(custom);
  expect(
    createFirestoreCollectionSyncAdapter({ db, ...handlers, resolveRemoteId }).checkpointSerializer,
  ).toBeUndefined();
  expect(
    createFirestoreCollectionSyncAdapter({
      db,
      ...handlers,
      resolveRemoteId,
      checkpointSerializer: custom,
    }).checkpointSerializer,
  ).toBe(custom);
});

test("realtime database adapters leave checkpoints to the client's JSON unless given a serializer", () => {
  expect(createRealtimeDBSyncAdapter({ db, collections: [] }).checkpointSerializer).toBeUndefined();
  expect(
    createRealtimeDBSyncAdapter({ db, collections: [], checkpointSerializer: custom })
      .checkpointSerializer,
  ).toBe(custom);
  expect(
    createRealtimeDBCollectionSyncAdapter({ db, ...handlers, resolveRemoteId })
      .checkpointSerializer,
  ).toBeUndefined();
  expect(
    createRealtimeDBCollectionSyncAdapter({
      db,
      ...handlers,
      resolveRemoteId,
      checkpointSerializer: custom,
    }).checkpointSerializer,
  ).toBe(custom);
});
