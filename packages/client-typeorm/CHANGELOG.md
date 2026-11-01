# Changelog

## [0.1.2](https://github.com/Ez-Kits/sync/compare/sync-client-typeorm-adapter-v0.1.1...sync-client-typeorm-adapter-v0.1.2) (2026-11-01)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ez-kits/sync-client-core bumped to 0.1.2
    * @ez-kits/sync-client-storage-pglite bumped to 0.0.3
    * @ez-kits/sync-client-storage-sqljs bumped to 0.0.3
  * peerDependencies
    * @ez-kits/sync-client-core bumped to 0.1.2

## [0.1.1](https://github.com/Ez-Kits/sync/compare/sync-client-typeorm-adapter-v0.1.0...sync-client-typeorm-adapter-v0.1.1) (2026-11-01)


### Features

* expose pending (unpushed) writes ([#4](https://github.com/Ez-Kits/sync/issues/4)) ([81acf64](https://github.com/Ez-Kits/sync/commit/81acf64854bc8989a6e5461bd936f3934cf52828))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ez-kits/sync-client-core bumped to 0.1.1
    * @ez-kits/sync-client-storage-pglite bumped to 0.0.2
    * @ez-kits/sync-client-storage-sqljs bumped to 0.0.2
  * peerDependencies
    * @ez-kits/sync-client-core bumped to 0.1.1

## 0.1.0 (2026-10-31)


### Features

* **client-typeorm:** create the data source on DBStorage with sqlite and pg entry points ([36edd16](https://github.com/Ez-Kits/sync/commit/36edd16c87a9dee2cbb81df4e4e948f003be0138))
* **db-storage:** run the database in a leader worker behind a DBStorage contract ([fc54085](https://github.com/Ez-Kits/sync/commit/fc5408553009093e32beca8468c9a755da6c04ed))
* improve sync performance with batch update and transaction ([b4e9cf1](https://github.com/Ez-Kits/sync/commit/b4e9cf10c19c031c8330c7388e059ddec8848483))
* infer checkpoint types from sync adapters, add adapter checkpoint serializers and align option names across packages ([a5cc61b](https://github.com/Ez-Kits/sync/commit/a5cc61bec03414afccfe4085ea379b82e3ae2797))
* initialize project with base implementation of core sync client and db adapter with sync firestore ([e5977fd](https://github.com/Ez-Kits/sync/commit/e5977fdc0400644d69e3ff68bae1ded886a6f805))
* keep checkpoint storage internal and expose only checkpoint serialization ([241c041](https://github.com/Ez-Kits/sync/commit/241c0418c7c92d0ffb408cf9847b14650e540fdd))
* **storage-coordination:** implement coordinated storage with mutex and protocol handling ([9741894](https://github.com/Ez-Kits/sync/commit/9741894665f4a93e1215f1db9d053a22bd82a189))
* **sync-conflict-resolution:** add conflict resolution policies and package structure ([b0dcfae](https://github.com/Ez-Kits/sync/commit/b0dcfae73d89c975635ce7a4d1bb8d173d6b86b4))
* **sync:** enforce crash-safe atomic local mutations ([cb9a3d6](https://github.com/Ez-Kits/sync/commit/cb9a3d659cc2d5aae5a3003907f7fb8b56a5d9ff))
* **sync:** implement retry logic for pull listeners and enhance push handling with abort support ([ea4582a](https://github.com/Ez-Kits/sync/commit/ea4582a4f25496872b315710bf7c65fc2881c01f))
* **sync:** introduce SyncAdapter API and update DB adapters for production readiness ([539c413](https://github.com/Ez-Kits/sync/commit/539c413b1234fb88b76931170cbd0476764d4630))


### Bug Fixes

* **client-typeorm:** run adapter transactions on their own data source on SQLite ([606408d](https://github.com/Ez-Kits/sync/commit/606408dc99db7e43e9a55592699dca9d098808ee))
* close the db adapter on dispose so typeorm data sources are destroyed ([8c632e3](https://github.com/Ez-Kits/sync/commit/8c632e33e0d7df829ba0f240e68f2d4fa34b89fc))
* reject composite keys, fail on worker load errors, and keep unsynced writes out of the outbox ([737c8b7](https://github.com/Ez-Kits/sync/commit/737c8b73748c8fbbffe3f39effd1bb9da98e4271))
* store checkpoints and skipped remote events in the database ([b322bb8](https://github.com/Ez-Kits/sync/commit/b322bb84861131ae57b8a88ca1e423341691afac))
* **sync:** keep the outbox consistent across push, pull and tabs ([50443fe](https://github.com/Ez-Kits/sync/commit/50443fee4a895425e3ee621f9dfa0a6fd92714de))
* **sync:** recognise a retried mutation by a durable record of its event id ([0eac801](https://github.com/Ez-Kits/sync/commit/0eac80192f569415f470bb851d6ef4c694b6f3a3))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ez-kits/sync-client-core bumped to 0.1.0
    * @ez-kits/sync-client-storage-pglite bumped to 0.0.1
    * @ez-kits/sync-client-storage-sqljs bumped to 0.0.1
  * peerDependencies
    * @ez-kits/sync-client-core bumped to 0.1.0
