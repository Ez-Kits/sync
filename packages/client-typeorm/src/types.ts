import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
} from "@ez-kits/sync-client-core";
import type { DataSource, ObjectLiteral, Repository } from "typeorm";

export type TypeOrmQueryResult<Q> = Q extends Promise<infer R> ? R : Q;

/** The repository of each entity in a collection-name → entity-class map. */
export type TypeOrmRepositories<TSchema> = {
  readonly [K in keyof TSchema]: TSchema[K] extends abstract new (...args: any[]) => infer T
    ? T extends ObjectLiteral
      ? Repository<T>
      : never
    : never;
};

/**
 * The adapter's data source, with a typed repository per collection:
 * `db.repositories.todos.find({ where: { completed: false } })`.
 */
export type TypeOrmDatabase<TSchema> = DataSource & {
  readonly repositories: TypeOrmRepositories<TSchema>;
};

export interface TypeOrmDBAdapter<
  C extends CollectionConfigMap,
  TSchema extends Record<CollectionNames<C>, unknown>,
> extends BaseDBAdapter<C, TypeOrmDatabase<TSchema>, TSchema> {
  /** The data source the adapter created on its storage. */
  readonly db: TypeOrmDatabase<TSchema>;
  readonly schema: TSchema;
}
