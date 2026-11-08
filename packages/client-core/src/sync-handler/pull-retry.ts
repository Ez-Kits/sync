/** A pull stream, as `retryPull` hands it out. */
export interface PullStream {
  isActive: () => boolean;
  onError: (error: unknown) => void;
}

export type PullSubscribe = (
  onError: (error: unknown) => void,
  isActive: () => boolean,
) => void | (() => void) | Promise<void | (() => void)>;

/**
 * Keep a pull listener alive across provider errors while retaining checkpoint safety.
 *
 * Every subscription is one stream. `onError` fails it: the listener is torn down and a new
 * stream resubscribes from the persisted checkpoint after a backoff. `isActive` turns false
 * once the stream failed or the pull stopped; nothing it delivers afterwards may be
 * committed, since providers only send what came after their own last batch.
 */
export function retryPull(
  callbacks: { onSyncError?: (error: unknown) => void; onSyncSuccess?: () => void },
  subscribe: PullSubscribe,
): () => void {
  let active = true;
  let connecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let currentStream: object | undefined;
  let currentCleanup: (() => void) | undefined;
  let retryDelayMs = 250;

  const scheduleReconnect = () => {
    if (!active || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 8_000);
  };

  const failStream = (stream: object, error: unknown) => {
    if (!active) return;
    callbacks.onSyncError?.(error);
    // A stream that already failed has been replaced; its errors only get reported.
    if (currentStream !== stream) return;
    currentStream = undefined;
    const cleanup = currentCleanup;
    currentCleanup = undefined;
    cleanup?.();
    scheduleReconnect();
  };

  const connect = async () => {
    if (!active || connecting) return;
    connecting = true;
    const cleanup = currentCleanup;
    currentCleanup = undefined;
    cleanup?.();
    const stream = {};
    currentStream = stream;
    try {
      const unsubscribe = await subscribe(
        (error) => failStream(stream, error),
        () => active && currentStream === stream,
      );
      if (active && currentStream === stream) {
        if (typeof unsubscribe === "function") currentCleanup = unsubscribe;
        retryDelayMs = 250;
        callbacks.onSyncSuccess?.();
      } else {
        unsubscribe?.();
        // It failed while connecting, when a retry that fired was skipped.
        scheduleReconnect();
      }
    } catch (error) {
      failStream(stream, error);
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  };

  void connect();
  return () => {
    active = false;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    currentCleanup?.();
    currentCleanup = undefined;
  };
}
