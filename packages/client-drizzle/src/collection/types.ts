import type {
  CollectionConfig,
  CollectionConfigMap,
  CollectionNames,
} from "@ez-kits/sync-client-core";
import type { Table, InferInsertModel, InferSelectModel, Column } from "drizzle-orm";

export type InferPrimaryField<TColumns extends Record<string, any>> = {
  [K in keyof TColumns]: TColumns[K] extends infer TColumn extends Column
    ? TColumn["_"]["isPrimaryKey"] extends true
      ? K
      : never
    : never;
}[keyof TColumns];

export type DrizzleCollectionConfig<
  TName extends string,
  T extends Table,
  InsertModel = InferInsertModel<T>,
  UpdateModel = Partial<InsertModel>,
  SelectModel = InferSelectModel<T>,
  PrimaryKey extends keyof SelectModel = Extract<
    InferPrimaryField<T["_"]["columns"]>,
    keyof SelectModel
  >,
  TCheckpoint = unknown,
> = CollectionConfig<
  TName,
  { table: T },
  UpdateModel,
  InsertModel,
  SelectModel,
  PrimaryKey,
  TCheckpoint
>;

export type BuildSchemaFromCollections<C extends CollectionConfigMap> = {
  [K in CollectionNames<C>]: Extract<C[number], { name: K }>["adapterConfig"] extends {
    table: infer T extends Table;
  }
    ? T
    : never;
};
