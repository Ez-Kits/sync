import type { ChangeBus } from "../change-bus";
import type { BaseDBAdapter } from "../db-adapter";
import type { ILocalChangeStore, StoredChangeBusEvent } from "../local-change-store";
import type {
  CollectionConfig,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
  TCollectionRuntime,
} from "./types";

export class CollectionRuntime<
  C extends CollectionConfig<any, any, any, any, any, any>,
  DB extends BaseDBAdapter<any, any, any>,
> implements TCollectionRuntime<C> {
  constructor(
    private config: C,
    private db: DB,
    private changeBus: ChangeBus<any>,
    private localChangeStore: ILocalChangeStore,
  ) {}

  async insert(data: InferCollectionInsertModel<C>): Promise<void> {
    await this.db.insert(this.config.name, data);

    const eventId = crypto.randomUUID();
    const recordId = String((data as Record<string, unknown>)[String(this.config.primaryField)]);
    const now = Date.now();

    const storedEvent: StoredChangeBusEvent = {
      id: eventId,
      type: "create",
      collection: this.config.name,
      data,
      recordId,
      createdAt: now,
    };

    await this.localChangeStore.appendEvents([storedEvent]);
    await this.localChangeStore.upsertDirtyRecord({
      collection: this.config.name,
      recordId,
      state: "dirty",
      updatedAt: now,
    });

    this.changeBus.publishLocal({
      type: "create",
      collection: this.config.name,
      data,
      eventId,
    });
  }

  async update(data: InferCollectionUpdateModel<C>): Promise<void> {
    await this.db.update(this.config.name, data);

    const eventId = crypto.randomUUID();
    const recordId = String((data as Record<string, unknown>)[String(this.config.primaryField)]);
    const now = Date.now();

    const storedEvent: StoredChangeBusEvent = {
      id: eventId,
      type: "update",
      collection: this.config.name,
      data,
      recordId,
      createdAt: now,
    };

    await this.localChangeStore.appendEvents([storedEvent]);
    await this.localChangeStore.upsertDirtyRecord({
      collection: this.config.name,
      recordId,
      state: "dirty",
      updatedAt: now,
    });

    this.changeBus.publishLocal({
      type: "update",
      collection: this.config.name,
      data,
      eventId,
    });
  }

  async delete(id: InferCollectionPrimaryFieldType<C>): Promise<void> {
    await this.db.delete(this.config.name, id);

    const eventId = crypto.randomUUID();
    const recordId = String(id);
    const now = Date.now();

    const storedEvent: StoredChangeBusEvent = {
      id: eventId,
      type: "delete",
      collection: this.config.name,
      recordId,
      createdAt: now,
    };

    await this.localChangeStore.appendEvents([storedEvent]);
    await this.localChangeStore.upsertDirtyRecord({
      collection: this.config.name,
      recordId,
      state: "deleted",
      updatedAt: now,
    });

    this.changeBus.publishLocal({
      type: "delete",
      collection: this.config.name,
      id,
      eventId,
    });
  }

  async get(id: InferCollectionPrimaryFieldType<C>): Promise<InferCollectionSelectModel<C>> {
    return (await this.db.get(this.config.name, id)) as InferCollectionSelectModel<C>;
  }

  async getMany(): Promise<InferCollectionSelectModel<C>[]> {
    return (await this.db.getMany(this.config.name)) as InferCollectionSelectModel<C>[];
  }
}
