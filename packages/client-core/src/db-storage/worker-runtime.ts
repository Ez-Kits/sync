import { serializeError } from "./errors";
import { DBStorageNode, type LockManagerLike } from "./node";
import type { BroadcastChannelConstructor, PortMessage, PortRequest } from "./protocol";
import type { MessageEndpoint } from "./port-db-storage";
import type { DBEngineFactory, OpenDBEngine } from "./types";

export type DBStorageWorkerScope = MessageEndpoint & {
  navigator?: { locks?: LockManagerLike };
  BroadcastChannel?: BroadcastChannelConstructor;
};

/**
 * Serve a {@link createWorkerDBStorage} from inside its worker. Call it once at the top of
 * the worker module. `open` runs only while this worker leads, so put migrations there.
 * Pass `{ open, destroy }` to let `DBStorage.destroy` delete the database.
 */
export function startDBStorageWorker<TEngineOptions = unknown>(
  engine: OpenDBEngine<TEngineOptions> | DBEngineFactory<TEngineOptions>,
  scope: DBStorageWorkerScope = globalThis as unknown as DBStorageWorkerScope,
): void {
  const { open, destroy } = typeof engine === "function" ? { open: engine } : engine;
  let node: DBStorageNode | undefined;
  const post = (message: PortMessage) => scope.postMessage(message);
  const respond = (id: number, task: (node: DBStorageNode) => Promise<unknown>) => {
    if (!node) {
      post({ t: "response", id, ok: false, error: serializeError(notInitialized()) });
      return;
    }
    task(node).then(
      (result) => post({ t: "response", id, ok: true, result }),
      (error: unknown) => post({ t: "response", id, ok: false, error: serializeError(error) }),
    );
  };

  scope.onmessage = (event: MessageEvent) => {
    const message = event.data as PortRequest;
    switch (message?.t) {
      case "init": {
        if (node) return;
        post({ t: "started" });
        const { engineOptions, t: _t, ...options } = message;
        node = new DBStorageNode({
          ...options,
          open: async (signal) => open(engineOptions as TEngineOptions, { signal }),
          destroy: destroy && (async () => destroy(engineOptions as TEngineOptions)),
          host: { locks: scope.navigator?.locks, BroadcastChannel: scope.BroadcastChannel },
          events: {
            role: (role) => post({ t: "role", role }),
            invalidate: () => post({ t: "invalidate" }),
            error: (error) => post({ t: "error", error: serializeError(error) }),
            destroyed: () => post({ t: "destroyed" }),
          },
        });
        return;
      }
      case "request": {
        const { body } = message;
        respond(message.id, (node) => node.request(body));
        return;
      }
      case "release":
        node?.release();
        return;
      case "rejoin":
        node?.rejoin();
        return;
      case "destroy":
        respond(message.id, (node) => node.destroy());
        return;
      case "close":
        void (node?.close() ?? Promise.resolve()).then(() =>
          post({ t: "response", id: message.id, ok: true }),
        );
        return;
    }
  };
  post({ t: "started" });
}

function notInitialized(): Error {
  return new Error("The storage worker received a request before it was initialized.");
}
