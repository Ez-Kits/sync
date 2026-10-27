import type { ChangeBus } from "../change-bus";
import type { DBAdapterOperations } from "../db-adapter";
import { toChangeBusEvent, type LocalMutation, type MutationSink } from "./local-mutation";
import type {
  CollectionConfig,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
  TCollectionRuntime,
} from "./types";

type LocalMutationInput = LocalMutation extends infer M
  ? M extends unknown
    ? Omit<M, "eventId" | "recordId" | "createdAt">
    : never
  : never;

/** Where a runtime reads from and commits to; resolves once storage is usable. */
export interface CollectionRuntimeStorage {
  resolve(): Promise<{ dbAdapter: DBAdapterOperations<any>; mutations: MutationSink }>;
}

export class CollectionRuntime<
  C extends CollectionConfig<any, any, any, any, any, any>,
> implements TCollectionRuntime<C> {
  constructor(
    private config: C,
    private storage: CollectionRuntimeStorage,
    private changeBus: ChangeBus<any>,
  ) {}

  private async commit(mutation: LocalMutationInput): Promise<void> {
    const local = {
      ...mutation,
      eventId: crypto.randomUUID(),
      recordId: String(mutation.id),
      createdAt: Date.now(),
    } as LocalMutation;
    const { mutations } = await this.storage.resolve();
    await mutations.commit(local);
    this.changeBus.publishLocal(toChangeBusEvent(local));
  }

  private primaryKeyOf(data: unknown): unknown {
    return (data as Record<string, unknown>)[String(this.config.primaryField)];
  }

  async insert(data: InferCollectionInsertModel<C>): Promise<void> {
    await this.commit({
      type: "create",
      collection: this.config.name,
      id: this.primaryKeyOf(data),
      data,
    });
  }

  async update(data: InferCollectionUpdateModel<C>): Promise<void> {
    await this.commit({
      type: "update",
      collection: this.config.name,
      id: this.primaryKeyOf(data),
      data,
    });
  }

  async delete(id: InferCollectionPrimaryFieldType<C>): Promise<void> {
    await this.commit({ type: "delete", collection: this.config.name, id });
  }

  async get(id: InferCollectionPrimaryFieldType<C>): Promise<InferCollectionSelectModel<C>> {
    const { dbAdapter } = await this.storage.resolve();
    return (await dbAdapter.get(this.config.name, id)) as InferCollectionSelectModel<C>;
  }

  async getMany(): Promise<InferCollectionSelectModel<C>[]> {
    const { dbAdapter } = await this.storage.resolve();
    return (await dbAdapter.getMany(this.config.name)) as InferCollectionSelectModel<C>[];
  }
}
