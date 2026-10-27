import type { CollectionConfigMap } from "@ez-kits/sync-client-core";
import { defineRelations } from "drizzle-orm";
import { buildSchemaFromCollections } from "./build-schema-from-collections";
import type { BuildRelationsFromCollections } from "./types";

/**
 * Relational config with every collection table and no relations between them, so
 * `db.query.<collection>.findMany()` works without writing `defineRelations` yourself.
 */
export function buildRelationsFromCollections<C extends CollectionConfigMap>(
  collections: C,
): BuildRelationsFromCollections<C> {
  return defineRelations(
    buildSchemaFromCollections(collections),
  ) as BuildRelationsFromCollections<C>;
}
