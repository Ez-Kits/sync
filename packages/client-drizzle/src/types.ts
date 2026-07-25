import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
} from "@ez-kits/sync-client-core";
import type { RunnableQuery } from "drizzle-orm/runnable-query";

export type DrizzleQueryResult<QO extends RunnableQuery<any, any> = RunnableQuery<any, any>> =
  QO["_"]["result"];

export interface DrizzleDBAdapter<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TSchema extends Record<CollectionNames<C>, unknown>,
> extends BaseDBAdapter<C, TDrizzleDB, TSchema> {
  readonly db: TDrizzleDB;
  readonly schema: TSchema;
}
