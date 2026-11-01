import type { ChangeBus } from "../change-bus";
import type { DBAdapterOperations } from "../db-adapter";
import {
  toChangeBusEvent,
  type LocalMutation,
  type LocalMutationWriter,
  type MutationSink,
} from "./local-mutation";
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

/** The reads and writes of one collection; subclasses decide where they go. */
abstract class CollectionAccess<
  C extends CollectionConfig<any, any, any, any, any, any>,
> implements TCollectionRuntime<C> {
  constructor(protected readonly config: C) {}

  /** Apply mutations together: all of them or none. Never called with an empty list. */
  protected abstract write(mutations: LocalMutation[]): Promise<void>;
  protected abstract operations(): Promise<DBAdapterOperations<any>>;

  private async commit(inputs: LocalMutationInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const createdAt = Date.now();
    await this.write(
      inputs.map(
        (input) =>
          ({
            ...input,
            eventId: crypto.randomUUID(),
            recordId: this.recordIdOf(input.id),
            createdAt,
          }) as LocalMutation,
      ),
    );
  }

  /**
   * The outbox and dirty records identify a record by its primary key as a string, so only
   * single-column keys (a string or a number) are supported.
   */
  private recordIdOf(id: unknown): string {
    if (typeof id === "string" || typeof id === "number") return String(id);
    throw new TypeError(
      `Collection "${this.config.name}" needs a string or number value in its primary field ` +
        `"${String(this.config.primaryField)}", got ${id === null ? "null" : typeof id}. ` +
        "Composite primary keys are not supported.",
    );
  }

  private withData(type: "create" | "update" | "upsert", data: unknown): LocalMutationInput {
    const id = (data as Record<string, unknown>)[String(this.config.primaryField)];
    return { type, collection: this.config.name, id, data };
  }

  private deletion(id: unknown): LocalMutationInput {
    return { type: "delete", collection: this.config.name, id };
  }

  async insert(data: InferCollectionInsertModel<C>): Promise<void> {
    await this.commit([this.withData("create", data)]);
  }

  async update(data: InferCollectionUpdateModel<C>): Promise<void> {
    await this.commit([this.withData("update", data)]);
  }

  async upsert(data: InferCollectionInsertModel<C>): Promise<void> {
    await this.commit([this.withData("upsert", data)]);
  }

  async delete(id: InferCollectionPrimaryFieldType<C>): Promise<void> {
    await this.commit([this.deletion(id)]);
  }

  async insertMany(data: readonly InferCollectionInsertModel<C>[]): Promise<void> {
    await this.commit(data.map((row) => this.withData("create", row)));
  }

  async updateMany(data: readonly InferCollectionUpdateModel<C>[]): Promise<void> {
    await this.commit(data.map((row) => this.withData("update", row)));
  }

  async upsertMany(data: readonly InferCollectionInsertModel<C>[]): Promise<void> {
    await this.commit(data.map((row) => this.withData("upsert", row)));
  }

  async deleteMany(ids: readonly InferCollectionPrimaryFieldType<C>[]): Promise<void> {
    await this.commit(ids.map((id) => this.deletion(id)));
  }

  async get(id: InferCollectionPrimaryFieldType<C>): Promise<InferCollectionSelectModel<C>> {
    const operations = await this.operations();
    return (await operations.get(this.config.name, id)) as InferCollectionSelectModel<C>;
  }

  async getMany(): Promise<InferCollectionSelectModel<C>[]> {
    const operations = await this.operations();
    return (await operations.getMany(this.config.name)) as InferCollectionSelectModel<C>[];
  }
}

/** A collection of the client: each write is its own transaction, published once committed. */
export class CollectionRuntime<
  C extends CollectionConfig<any, any, any, any, any, any>,
> extends CollectionAccess<C> {
  constructor(
    config: C,
    private storage: CollectionRuntimeStorage,
    private changeBus: ChangeBus<any>,
  ) {
    super(config);
  }

  protected async write(mutations: LocalMutation[]): Promise<void> {
    const { mutations: sink } = await this.storage.resolve();
    const { applied } = await sink.commit((writer) => writer.apply(mutations));
    this.changeBus.publishLocalBatch(applied.map(toChangeBusEvent));
  }

  protected async operations(): Promise<DBAdapterOperations<any>> {
    return (await this.storage.resolve()).dbAdapter;
  }
}

/** A collection inside `client.transaction`: writes join its transaction, reads see them. */
export class TransactionCollection<
  C extends CollectionConfig<any, any, any, any, any, any>,
> extends CollectionAccess<C> {
  constructor(
    config: C,
    private writer: LocalMutationWriter,
  ) {
    super(config);
  }

  protected async write(mutations: LocalMutation[]): Promise<void> {
    await this.writer.apply(mutations);
  }

  protected async operations(): Promise<DBAdapterOperations<any>> {
    return this.writer.operations;
  }
}
