export type DirtyRecordState = "dirty" | "deleted";

export interface StoredChangeBusEvent {
  id: string;
  type: "create" | "update" | "delete";
  collection: string;
  /** Present for create/update events. */
  data?: unknown;
  /** Stringified primary key for indexing and dirty tracking. */
  recordId: string;
  createdAt: number;
}

export interface DirtyRecord {
  collection: string;
  recordId: string;
  state: DirtyRecordState;
  updatedAt: number;
}

export interface DirtyRecordKey {
  collection: string;
  recordId: string;
}

export interface ILocalChangeStore {
  appendEvents(events: StoredChangeBusEvent[]): Promise<void>;
  getPendingEvents(collection?: string): Promise<StoredChangeBusEvent[]>;
  deleteEvents(ids: string[]): Promise<void>;
  upsertDirtyRecord(record: DirtyRecord): Promise<void>;
  removeDirtyRecords(keys: DirtyRecordKey[]): Promise<void>;
  getDirtyRecords(collection?: string): Promise<DirtyRecord[]>;
}
