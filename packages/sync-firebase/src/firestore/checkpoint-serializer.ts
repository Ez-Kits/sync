import type { CheckpointSerializer } from "@ez-kits/sync-client-core";
import { Timestamp } from "firebase/firestore";

/** The `type` tag of `Timestamp.toJSON()`, which `JSON.stringify` writes for every `Timestamp`. */
const TIMESTAMP_TYPE = new Timestamp(0, 0).toJSON().type;

function isTimestampJSON(value: unknown): value is ReturnType<Timestamp["toJSON"]> {
  if (typeof value !== "object" || value === null) return false;
  const { type, seconds, nanoseconds } = value as Record<string, unknown>;
  return type === TIMESTAMP_TYPE && typeof seconds === "number" && typeof nanoseconds === "number";
}

/** JSON in which `Timestamp`s, at any depth, come back as `Timestamp`s. */
export const firestoreCheckpointSerializer: CheckpointSerializer<any> = {
  serialize: (checkpoint) => JSON.stringify(checkpoint),
  deserialize: (value) =>
    JSON.parse(value, (_key, field: unknown) =>
      isTimestampJSON(field) ? Timestamp.fromJSON(field) : field,
    ),
};
