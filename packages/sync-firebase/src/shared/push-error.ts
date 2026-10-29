import { PushRejectedError } from "@ez-kits/sync-client-core";

/**
 * Firestore codes (`FirestoreError.code`) of a write refused as sent: resending it unchanged
 * fails the same way until something changes (rules, sign-in, data), so core parks it
 * instead of retrying it in front of every later write.
 * - `permission-denied`: security rules, including their data validation, refused it.
 * - `invalid-argument`: invalid data or path, such as an unsupported field value.
 * - `out-of-range`: a value outside what Firestore stores, such as a timestamp before year 1.
 * - `failed-precondition`: the stored document does not meet a precondition of the write.
 *
 * Every other code is retried. `unavailable`, `deadline-exceeded`, `cancelled`, `aborted`,
 * `internal` and `unknown` are transport or backend conditions that pass; `resource-exhausted`
 * is a quota or rate limit that refills; `unauthenticated` means missing or expired
 * credentials, which signing in again fixes. Unlisted codes are retried as well: retrying a
 * write by mistake only delays it, parking it by mistake holds it until a retry.
 */
const PERMANENT_FIRESTORE_CODES = new Set([
  "permission-denied",
  "invalid-argument",
  "out-of-range",
  "failed-precondition",
]);

/**
 * Realtime Database write failures carry the server status, upper-cased, in `code`. Only
 * `PERMISSION_DENIED` is permanent: rules, `.validate` included, refused the write. Others
 * (`DISCONNECTED`, `EXPIRED_TOKEN`, `INVALID_TOKEN`, `UNAVAILABLE`, ...) are retried.
 */
const PERMANENT_REALTIME_DB_CODES = new Set(["PERMISSION_DENIED"]);

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

/** Wrap a refusal for core; the message names only the code, never document data. */
export function rejectedPush(provider: string, error: unknown): PushRejectedError {
  const code = errorCode(error);
  const reason = typeof code === "string" ? ` (${code})` : "";
  return new PushRejectedError(`${provider} rejected the write${reason}.`, { cause: error });
}

/** A Firestore write failure, as a `PushRejectedError` when it is permanent. */
export function firestorePushError(error: unknown): unknown {
  const code = errorCode(error);
  if (typeof code === "string" && PERMANENT_FIRESTORE_CODES.has(code)) {
    return rejectedPush("Firestore", error);
  }
  return error;
}

/** A Realtime Database write failure, as a `PushRejectedError` when it is permanent. */
export function realtimeDBPushError(error: unknown): unknown {
  const code = errorCode(error);
  if (typeof code === "string" && PERMANENT_REALTIME_DB_CODES.has(code)) {
    return rejectedPush("Realtime Database", error);
  }
  return error;
}
