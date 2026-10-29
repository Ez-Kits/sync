/**
 * The provider refused the pushed events as sent (security rules, validation): sending them
 * again meets the same refusal until something changes. Throw it, or any error with
 * `permanent: true`, from `SyncAdapter.push`; core parks the refused events (see
 * `PushRejection`). Other errors are retried.
 */
export class PushRejectedError extends Error {
  override readonly name = "PushRejectedError";
  readonly permanent = true;
  constructor(message = "The sync provider rejected the push.", options?: ErrorOptions) {
    super(message, options);
  }
}

/** Whether a push failure is permanent, so core isolates and parks the refused events. */
export function isPermanentPushError(error: unknown): boolean {
  return (error as { permanent?: unknown } | null | undefined)?.permanent === true;
}
