import { serializeError } from "./errors";
import { DBStorageNode, type LockManagerLike } from "./node";
import type { BroadcastChannelConstructor, PortMessage, PortRequest } from "./protocol";
import type { MessageEndpoint } from "./port-db-storage";
import type { OpenDBEngine } from "./types";

export type DBStorageWorkerScope = MessageEndpoint & {
  navigator?: { locks?: LockManagerLike };
  BroadcastChannel?: BroadcastChannelConstructor;
};

/**
 * Serve a {@link createWorkerDBStorage} from inside its worker. Call it once at the top of
 * the worker module. `open` runs only while this worker leads, so put migrations there.
 */
export function startDBStorageWorker<TEngineOptions = unknown>(
  open: OpenDBEngine<TEngineOptions>,
  scope: DBStorageWorkerScope = globalThis as unknown as DBStorageWorkerScope,
): void {
  let node: DBStorageNode | undefined;
  const post = (message: PortMessage) => scope.postMessage(message);

  scope.onmessage = (event: MessageEvent) => {
    const message = event.data as PortRequest;
    switch (message?.t) {
      case "init": {
        if (node) return;
        const { engineOptions, t: _t, ...options } = message;
        node = new DBStorageNode({
          ...options,
          open: async (signal) => open(engineOptions as TEngineOptions, { signal }),
          host: { locks: scope.navigator?.locks, BroadcastChannel: scope.BroadcastChannel },
          events: {
            role: (role) => post({ t: "role", role }),
            invalidate: () => post({ t: "invalidate" }),
            error: (error) => post({ t: "error", error: serializeError(error) }),
          },
        });
        return;
      }
      case "request": {
        const { id } = message;
        if (!node) {
          post({ t: "response", id, ok: false, error: serializeError(notInitialized()) });
          return;
        }
        node.request(message.body).then(
          (result) => post({ t: "response", id, ok: true, result }),
          (error: unknown) => post({ t: "response", id, ok: false, error: serializeError(error) }),
        );
        return;
      }
      case "release":
        node?.release();
        return;
      case "rejoin":
        node?.rejoin();
        return;
      case "close":
        void (node?.close() ?? Promise.resolve()).then(() =>
          post({ t: "response", id: message.id, ok: true }),
        );
        return;
    }
  };
}

function notInitialized(): Error {
  return new Error("The storage worker received a request before it was initialized.");
}
