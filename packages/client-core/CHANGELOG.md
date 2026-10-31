# Changelog

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

* accept stored collections and policies, infer custom adapters, stabilize useLiveQuery, drop pendingEvents and keep delete id types ([5642849](https://github.com/Ez-Kits/sync/commit/564284913099561aaac52e9b0112481e4bbc3f8d))
* apply the echo of a pending push on ack and park rejected writes ([19fa9fe](https://github.com/Ez-Kits/sync/commit/19fa9fe43f36dbf4aee7bb72f1b828ecae9e770a))
* avoid the ErrorEvent global in worker storage tests for Node 24 ([#1](https://github.com/Ez-Kits/sync/issues/1)) ([112a112](https://github.com/Ez-Kits/sync/commit/112a11220a335e51ffa8ac7ca8cf992a785dcf11))
* close the db adapter on dispose so typeorm data sources are destroyed ([8c632e3](https://github.com/Ez-Kits/sync/commit/8c632e33e0d7df829ba0f240e68f2d4fa34b89fc))
* never skip a failed pull batch and reconcile conflict decisions with the outbox ([2bde176](https://github.com/Ez-Kits/sync/commit/2bde176f6928d733f80b15567428420db20a7562))
* probe a single parked write per retry and wire rejection handling in the examples ([03e8ac8](https://github.com/Ez-Kits/sync/commit/03e8ac8c5e006d68e6cab58b5f60831ce0232757))
* reject composite keys, fail on worker load errors, and keep unsynced writes out of the outbox ([737c8b7](https://github.com/Ez-Kits/sync/commit/737c8b73748c8fbbffe3f39effd1bb9da98e4271))
* store checkpoints and skipped remote events in the database ([b322bb8](https://github.com/Ez-Kits/sync/commit/b322bb84861131ae57b8a88ca1e423341691afac))
* **sync:** keep the outbox consistent across push, pull and tabs ([50443fe](https://github.com/Ez-Kits/sync/commit/50443fee4a895425e3ee621f9dfa0a6fd92714de))
* **sync:** recognise a retried mutation by a durable record of its event id ([0eac801](https://github.com/Ez-Kits/sync/commit/0eac80192f569415f470bb851d6ef4c694b6f3a3))
