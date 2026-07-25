import type { CollectionConfigMap } from "@ez-kits/sync-client-core";
import type { BuildSchemaFromCollections } from "./types";

export function buildSchemaFromCollections<C extends CollectionConfigMap>(
  collections: C,
): BuildSchemaFromCollections<C> {
  return Object.fromEntries(
    collections.map((c) => [c.name, c.adapterConfig.entity]),
  ) as BuildSchemaFromCollections<C>;
}
