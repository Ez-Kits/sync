import type {
  CollectionUpdateModel,
  PrimaryFieldSpec,
  PrimaryKeyValue,
  SyncAdapter,
} from "@ez-kits/sync-client-core";
import {
  getColumns,
  type Column,
  type InferInsertModel,
  type InferSelectModel,
  type Table,
} from "drizzle-orm";
import type { DefaultPrimaryField, DrizzleCollectionConfig } from "./types";

export type DefineDrizzleCollectionOptions<
  TName extends string,
  T extends Table,
  PrimaryField extends PrimaryFieldSpec<Model> = DefaultPrimaryField<T>,
  Model extends InferSelectModel<T> = InferSelectModel<T>,
  TCheckpoint = unknown,
> = {
  name: TName;
  table: T;
  syncAdapter?: SyncAdapter<
    Record<
      TName,
      {
        create: InferInsertModel<T>;
        update: CollectionUpdateModel<InferInsertModel<T>, Model, PrimaryField>;
        delete: PrimaryKeyValue<Model, PrimaryField>;
      }
    >,
    TName,
    TCheckpoint
  >;
} & ([DefaultPrimaryField<T>] extends [never]
  ? {
      /** The table's key is a constraint (`primaryKey({ columns })`): name its fields, in order. */
      primaryField: PrimaryField;
    }
  : { primaryField?: PrimaryField });

export function defineDrizzleCollection<
  TName extends string,
  T extends Table,
  const PrimaryField extends PrimaryFieldSpec<Model> = DefaultPrimaryField<T>,
  Model extends InferSelectModel<T> = InferSelectModel<T>,
  TCheckpoint = unknown,
>(
  options: DefineDrizzleCollectionOptions<TName, T, PrimaryField, Model, TCheckpoint>,
): DrizzleCollectionConfig<
  TName,
  T,
  InferInsertModel<T>,
  CollectionUpdateModel<InferInsertModel<T>, Model, PrimaryField>,
  Model,
  PrimaryField,
  TCheckpoint
> {
  const { name, table, primaryField, syncAdapter } = options;
  return {
    name,
    adapterConfig: {
      table,
    },
    primaryField: (primaryField ?? getPrimaryField(table)) as PrimaryField,
    syncAdapter,
  };
}

function getPrimaryField<T extends Table>(table: T): DefaultPrimaryField<T> {
  const columns = Object.entries(getColumns(table)) as [string, Column][];
  const primaryField = columns.find(([, column]) => {
    const metadata = column as Column & {
      primary?: boolean;
      _?: { isPrimaryKey?: boolean };
    };
    return metadata.primary ?? metadata._?.isPrimaryKey ?? false;
  });

  if (!primaryField) {
    throw new Error("Primary field not found");
  }

  return primaryField[0] as unknown as DefaultPrimaryField<T>;
}
