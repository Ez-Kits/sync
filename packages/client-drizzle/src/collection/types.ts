import type {
  CollectionConfig,
  CollectionConfigMap,
  CollectionNames,
  CollectionUpdateModel,
  PrimaryFieldSpec,
} from "@ez-kits/sync-client-core";
import type {
  Assume,
  Column,
  ExtractTablesWithRelations,
  InferInsertModel,
  InferSelectModel,
  Schema,
  Table,
} from "drizzle-orm";

export type InferPrimaryField<TColumns extends Record<string, any>> = {
  [K in keyof TColumns]: TColumns[K] extends infer TColumn extends Column
    ? TColumn["_"]["isPrimaryKey"] extends true
      ? K
      : never
    : never;
}[keyof TColumns];

/** The primary field the table's columns declare; `never` when its key is a table constraint. */
export type DefaultPrimaryField<T extends Table> = Extract<
  InferPrimaryField<T["_"]["columns"]>,
  keyof InferSelectModel<T>
>;

export type DrizzleCollectionConfig<
  TName extends string,
  T extends Table,
  InsertModel = InferInsertModel<T>,
  UpdateModel = CollectionUpdateModel<InsertModel, InferSelectModel<T>, DefaultPrimaryField<T>>,
  SelectModel = InferSelectModel<T>,
  PrimaryKey extends PrimaryFieldSpec<SelectModel> = Extract<
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

/** What `defineRelations(buildSchemaFromCollections(collections))` returns. */
export type BuildRelationsFromCollections<C extends CollectionConfigMap> =
  ExtractTablesWithRelations<{}, Assume<BuildSchemaFromCollections<C>, Schema>>;
