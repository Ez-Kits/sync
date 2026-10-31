import type { CheckpointSerializer } from "@ez-kits/sync-client-core";

/**
 * The default checkpoint serializer of the Realtime Database sync adapters: JSON. Realtime
 * Database values (and so the checkpoints built from them) are plain JSON.
 */
export const realtimeDBCheckpointSerializer: CheckpointSerializer<any> = {
  serialize: (checkpoint) => JSON.stringify(checkpoint),
  deserialize: (value) => JSON.parse(value),
};
