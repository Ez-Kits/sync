import type { SyncOptions } from "@ez-kits/sync-client-core";
import { getMetadataArgsStorage, type DeepPartial } from "typeorm";
import type { EntityClass, TypeOrmCollectionConfig } from "./types";

export type DefineTypeormCollectionOptions<
  TName extends string,
  E extends EntityClass<object>,
  PK extends keyof InstanceType<E> & string,
  TCheckpoint,
> = {
  name: TName;
  entity: E;
  primaryField: PK;
  sync?: SyncOptions<
    Record<
      TName,
      {
        create: DeepPartial<InstanceType<E>>;
        update: Partial<InstanceType<E>>;
        delete: InstanceType<E>[PK];
      }
    >,
    TName,
    TCheckpoint
  >;
};

export function defineTypeormCollection<
  TName extends string,
  E extends EntityClass<object>,
  PK extends keyof InstanceType<E> & string,
  TCheckpoint,
>(
  options: DefineTypeormCollectionOptions<TName, E, PK, TCheckpoint>,
): TypeOrmCollectionConfig<TName, InstanceType<E>, E, PK, TCheckpoint> {
  const { name, entity, primaryField, sync } = options;
  const metaPk = getPrimaryKeyPropertyName(entity);
  if (metaPk !== primaryField) {
    throw new Error(
      `Primary field mismatch: metadata has "${metaPk}", expected "${String(primaryField)}"`,
    );
  }
  return {
    name,
    adapterConfig: {
      entity,
    },
    primaryField,
    sync,
  };
}

function getPrimaryKeyPropertyName(entityClass: EntityClass): string {
  const storage = getMetadataArgsStorage();
  let ctor: Function | null = entityClass;
  while (ctor && ctor !== Object) {
    const primary = storage.columns.find(
      (col) => col.target === ctor && col.options.primary === true,
    );
    if (primary) {
      return primary.propertyName;
    }
    ctor = Object.getPrototypeOf(ctor);
  }
  throw new Error("Primary field not found");
}
