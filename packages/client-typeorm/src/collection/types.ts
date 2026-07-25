import type {
  CollectionConfig,
  CollectionConfigMap,
  CollectionNames,
} from "@ez-kits/sync-client-core";
import type { DeepPartial } from "typeorm";

export type EntityClass<T extends object = object> = abstract new (...args: any[]) => T;

export type TypeOrmCollectionConfig<
  TName extends string,
  TInstance extends object,
  E = unknown,
  PK extends keyof TInstance & string = keyof TInstance & string,
  TCheckpoint = unknown,
> = CollectionConfig<
  TName,
  { entity: E },
  Partial<TInstance>,
  DeepPartial<TInstance>,
  TInstance,
  PK,
  TCheckpoint
>;

export type BuildSchemaFromCollections<C extends CollectionConfigMap> = {
  [K in CollectionNames<C>]: Extract<C[number], { name: K }>["adapterConfig"] extends {
    entity: infer E;
  }
    ? E
    : never;
};
