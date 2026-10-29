# vite-plus-starter

A starter for creating a Vite Plus project.

`createSyncClientReact(options)` takes the options of `createSyncClient` from `@ez-kits/sync-client-core` (collections, `dbAdapter`, `syncAdapter`, the optional `checkpoint: { serialize, deserialize }`, ...) and returns the client with `SyncClientProvider`, `useSyncClient` and `useLiveQuery`. Checkpoints are stored in the adapter's database; see the core README.

## Development

- Install dependencies:

```bash
vp install
```

- Run the unit tests:

```bash
vp test
```

- Build the library:

```bash
vp pack
```
