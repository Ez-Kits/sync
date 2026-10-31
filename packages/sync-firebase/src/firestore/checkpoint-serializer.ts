import type { CheckpointSerializer } from "@ez-kits/sync-client-core";

export const firestoreCheckpointSerializer: CheckpointSerializer<any> = {
  serialize: (checkpoint) => JSON.stringify(checkpoint),
  deserialize: (value) => JSON.parse(value),
};
