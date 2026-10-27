import type {
  AtomicLocalChangeStore,
  BaseDBAdapter,
  CollectionConfig,
  DBStorage,
  ICheckpointStorage,
} from "../../src";

export interface TodoSelect {
  id: number;
  title: string;
  done: boolean;
}
export interface TodoInsert {
  id?: number;
  title: string;
  done?: boolean;
}
export interface TodoUpdate {
  id: number;
  title?: string;
  done?: boolean;
}

export interface UserSelect {
  uid: string;
  email: string;
}
export interface UserInsert {
  uid: string;
  email: string;
}
export interface UserUpdate {
  uid: string;
  email?: string;
}

export interface Checkpoint {
  cursor: string;
}

export type TodoConfig = CollectionConfig<
  "todos",
  { table: "todos" },
  TodoUpdate,
  TodoInsert,
  TodoSelect,
  "id",
  Checkpoint
>;
export type UserConfig = CollectionConfig<
  "users",
  { table: "users" },
  UserUpdate,
  UserInsert,
  UserSelect,
  "uid",
  Checkpoint
>;
export type Collections = [TodoConfig, UserConfig];

export interface QueryBuilder {
  select: <T>(from: T) => T;
}
export interface QuerySchema {
  todos: { kind: "todos-table" };
  users: { kind: "users-table" };
}
export type DB = BaseDBAdapter<Collections, QueryBuilder, QuerySchema>;

export declare const todoConfig: TodoConfig;
export declare const userConfig: UserConfig;
export declare const collections: Collections;
export declare const db: DB;
export declare const store: AtomicLocalChangeStore;
export declare const dbStorage: DBStorage;
export declare const checkpointStorage: ICheckpointStorage<"todos" | "users", Checkpoint>;
