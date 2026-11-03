import type { CollectionConfig } from "@ez-kits/sync-client-core";

/**
 * A composite key cannot be read back from a document id the app encodes itself, so its
 * collection must decode deleted ids with `deserializeDeleteId`.
 */
export function assertDeleteIdHook(
  collectionConfig: CollectionConfig<any, any, any, any, any, any>,
  deserializeDeleteId: unknown,
): void {
  if (!Array.isArray(collectionConfig.primaryField) || deserializeDeleteId) return;
  throw new Error(
    `Collection "${collectionConfig.name}" has a composite primary key: pass ` +
      "deserializeDeleteId to rebuild its key from a deleted document.",
  );
}
