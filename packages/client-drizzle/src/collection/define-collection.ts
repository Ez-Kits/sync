import type { SyncAdapter } from "@ez-kits/sync-client-core";
import {
  getColumns,
  type Column,
  type InferInsertModel,
  type InferSelectModel,
  type Table,
} from "drizzle-orm";
import type { DrizzleCollectionConfig, InferPrimaryField } from "./types";

type DefaultPrimaryField<T extends Table> = Extract<
  InferPrimaryField<T["_"]["columns"]>,
  keyof InferSelectModel<T>
>;

export type DefineDrizzleCollectionOptions<
  TName extends string,
  T extends Table,
  PrimaryField extends keyof Model = DefaultPrimaryField<T>,
  Model extends InferSelectModel<T> = InferSelectModel<T>,
  TCheckpoint = unknown,
> = {
  name: TName;
  table: T;
  primaryField?: PrimaryField;
  syncAdapter?: SyncAdapter<
    Record<
      TName,
      {
        create: InferInsertModel<T>;
        update: Partial<InferInsertModel<T>>;
        delete: Model[PrimaryField];
      }
    >,
    TName,
    TCheckpoint
  >;
};

export function defineDrizzleCollection<
  TName extends string,
  T extends Table,
  PrimaryField extends keyof Model = DefaultPrimaryField<T>,
  Model extends InferSelectModel<T> = InferSelectModel<T>,
  TCheckpoint = unknown,
>(
  options: DefineDrizzleCollectionOptions<TName, T, PrimaryField, Model, TCheckpoint>,
): DrizzleCollectionConfig<
  TName,
  T,
  InferInsertModel<T>,
  Partial<InferInsertModel<T>>,
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
