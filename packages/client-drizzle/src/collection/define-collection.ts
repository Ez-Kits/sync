import type { SyncOptions } from "@ez-kits/sync-client-core";
import type { Column, InferInsertModel, InferSelectModel, Table } from "drizzle-orm";
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
  sync?: SyncOptions<
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
  const { name, table, primaryField, sync } = options;
  return {
    name,
    adapterConfig: {
      table,
    },
    primaryField: (primaryField ?? getPrimaryField(table)) as PrimaryField,
    sync,
  };
}

function getPrimaryField<T extends Table>(table: T): DefaultPrimaryField<T> {
  const columns = Object.entries(table._.columns) as [string, Column][];
  const primaryField = columns.find(([, column]) => column._.isPrimaryKey);

  if (!primaryField) {
    throw new Error("Primary field not found");
  }

  return primaryField[0] as unknown as DefaultPrimaryField<T>;
}
