import type {
  CollectionUpdateModel,
  PrimaryKeyValue,
  SyncAdapter,
} from "@ez-kits/sync-client-core";
import { getMetadataArgsStorage, type DeepPartial } from "typeorm";
import type { EntityClass, TypeOrmCollectionConfig } from "./types";

/** One property of the entity, or a non-empty ordered list of them (composite key). */
export type EntityPrimaryField<E extends EntityClass<object>> =
  | EntityProperty<E>
  | readonly [EntityProperty<E>, ...EntityProperty<E>[]];

type EntityProperty<E extends EntityClass<object>> = keyof InstanceType<E> & string;

export type DefineTypeOrmCollectionOptions<
  TName extends string,
  E extends EntityClass<object>,
  PK extends EntityPrimaryField<E>,
  TCheckpoint,
> = {
  name: TName;
  entity: E;
  primaryField: PK;
  syncAdapter?: SyncAdapter<
    Record<
      TName,
      {
        create: DeepPartial<InstanceType<E>>;
        update: CollectionUpdateModel<InstanceType<E>, InstanceType<E>, PK>;
        delete: PrimaryKeyValue<InstanceType<E>, PK>;
      }
    >,
    TName,
    TCheckpoint
  >;
};

export function defineTypeOrmCollection<
  TName extends string,
  E extends EntityClass<object>,
  const PK extends EntityPrimaryField<E>,
  TCheckpoint,
>(
  options: DefineTypeOrmCollectionOptions<TName, E, PK, TCheckpoint>,
): TypeOrmCollectionConfig<TName, InstanceType<E>, E, PK, TCheckpoint> {
  const { name, entity, primaryField, syncAdapter } = options;
  const metaFields = getPrimaryKeyPropertyNames(entity);
  const fields: readonly string[] =
    typeof primaryField === "string" ? [primaryField] : primaryField;
  // Only the set must match: `primaryField` decides the order of a composite key.
  if (
    new Set(fields).size !== fields.length ||
    fields.length !== metaFields.length ||
    fields.some((field) => !metaFields.includes(field))
  ) {
    throw new Error(
      `Primary field mismatch: metadata has ${formatFields(metaFields)}, expected ` +
        `${formatFields(fields)}`,
    );
  }
  return {
    name,
    adapterConfig: {
      entity,
    },
    primaryField,
    syncAdapter,
  };
}

/** The entity's primary properties, from its class and the classes it extends. */
function getPrimaryKeyPropertyNames(entityClass: EntityClass): string[] {
  const storage = getMetadataArgsStorage();
  const names = new Set<string>();
  let ctor: Function | null = entityClass;
  while (ctor && ctor !== Object) {
    for (const col of storage.columns) {
      if (col.target === ctor && col.options.primary === true) names.add(col.propertyName);
    }
    ctor = Object.getPrototypeOf(ctor);
  }
  if (names.size === 0) throw new Error("Primary field not found");
  return [...names];
}

function formatFields(fields: readonly string[]): string {
  return fields.length === 1 ? `"${fields[0]}"` : JSON.stringify(fields);
}
