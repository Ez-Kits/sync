import type { ChangeBusEventDataMap, PullCheckpointMap } from "@ez-kits/sync-client-core";
import type { CollectionKey } from "./types.ts";

export function checkpointMapForCollection<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(collectionName: N, checkpoint: TCheckpoint): PullCheckpointMap<C, N, TCheckpoint> {
  return { [collectionName]: checkpoint } as PullCheckpointMap<C, N, TCheckpoint>;
}
