/** The default test for a tombstone: `deleted: true` on the document or node. */
export function defaultIsDeleted(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "deleted" in data &&
    (data as { deleted?: unknown }).deleted === true
  );
}

/** The `deletedAt` of a tombstone in milliseconds, as a number or a Firestore `Timestamp`. */
export function deletedAtFrom(data: unknown): number | undefined {
  const value =
    typeof data === "object" && data !== null && "deletedAt" in data ? data.deletedAt : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }
  return undefined;
}
