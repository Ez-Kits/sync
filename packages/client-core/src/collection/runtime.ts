import type { ChangeBus } from "../change-bus";
import type { BaseDBAdapter, DBAdapterOperations } from "../db-adapter";
import type { LocalMutationTransactionContext } from "../db-adapter/types";
import type { AtomicLocalChangeStore, StoredChangeBusEvent } from "../local-change-store";
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
    private localChangeStore: AtomicLocalChangeStore,
  ) {}

  private async commitLocalChange(
    event: StoredChangeBusEvent,
    mutate: (operations: DBAdapterOperations<any>) => Promise<void>,
    dirtyRecord: {
      collection: string;
      recordId: string;
      state: "dirty" | "deleted";
      updatedAt: number;
    },
  ): Promise<void> {
    if (typeof this.db.commitLocalMutation !== "function") {
      throw new Error("The database adapter must implement atomic local mutations.");
    }

    const persistOutboxEvent = (context: LocalMutationTransactionContext<any>) =>
      this.localChangeStore.appendEvents([event], context.native);
    const persistDirtyRecord = (context: LocalMutationTransactionContext<any>) =>
      this.localChangeStore.upsertDirtyRecord(dirtyRecord, context.native);
    await this.db.commitLocalMutation({
      mutate: (context) => mutate(context.operations),
      persistOutboxEvent,
      persistDirtyRecord,
    });
  }

  async insert(data: InferCollectionInsertModel<C>): Promise<void> {
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

    await this.commitLocalChange(
      storedEvent,
      (operations) => operations.insert(this.config.name, data),
      {
        collection: this.config.name,
        recordId,
        state: "dirty",
        updatedAt: now,
      },
    );

    this.changeBus.publishLocal({
      type: "create",
      collection: this.config.name,
      data,
      eventId,
    });
  }

  async update(data: InferCollectionUpdateModel<C>): Promise<void> {
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

    await this.commitLocalChange(
      storedEvent,
      (operations) => operations.update(this.config.name, data),
      {
        collection: this.config.name,
        recordId,
        state: "dirty",
        updatedAt: now,
      },
    );

    this.changeBus.publishLocal({
      type: "update",
      collection: this.config.name,
      data,
      eventId,
    });
  }

  async delete(id: InferCollectionPrimaryFieldType<C>): Promise<void> {
    const eventId = crypto.randomUUID();
    const recordId = String(id);
    const now = Date.now();

    const storedEvent: StoredChangeBusEvent = {
      id: eventId,
      type: "delete",
      collection: this.config.name,
      data: null,
      recordId,
      createdAt: now,
    };

    await this.commitLocalChange(
      storedEvent,
      (operations) => operations.delete(this.config.name, id),
      {
        collection: this.config.name,
        recordId,
        state: "deleted",
        updatedAt: now,
      },
    );

    this.changeBus.publishLocal({
      type: "delete",
      collection: this.config.name,
      id,
      deletedAt: now,
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
