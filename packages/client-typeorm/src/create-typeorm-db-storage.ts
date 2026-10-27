import { createLocalDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { DataSource } from "typeorm";

/**
 * A single-context {@link DBStorage} over a TypeORM data source: this context always
 * leads, statements run through `dataSource.query`, and closing leaves the data source
 * to the application.
 */
export function createTypeOrmDBStorage(dataSource: DataSource, key?: string): DBStorage {
  return createLocalDBStorage({
    dialect: dataSource.options.type === "postgres" ? "postgres" : "sqlite",
    key,
    open: () => ({
      exec: async (query) => {
        const rows: unknown = await dataSource.query(query.sql, query.params);
        return { rows: Array.isArray(rows) ? rows : [] };
      },
      close: async () => {},
    }),
  });
}
