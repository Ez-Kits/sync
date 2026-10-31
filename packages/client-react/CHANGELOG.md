# Changelog

## 0.1.0 (2026-10-31)


### Features

* add scoped sync client react provider and per-account examples ([278dded](https://github.com/Ez-Kits/sync/commit/278dded56e6a4bc8288db4f48975aeb38526285d))
* **db-storage:** run the database in a leader worker behind a DBStorage contract ([fc54085](https://github.com/Ez-Kits/sync/commit/fc5408553009093e32beca8468c9a755da6c04ed))
* infer checkpoint types from sync adapters, add adapter checkpoint serializers and align option names across packages ([a5cc61b](https://github.com/Ez-Kits/sync/commit/a5cc61bec03414afccfe4085ea379b82e3ae2797))
* initialize project with base implementation of core sync client and db adapter with sync firestore ([e5977fd](https://github.com/Ez-Kits/sync/commit/e5977fdc0400644d69e3ff68bae1ded886a6f805))
* keep checkpoint storage internal and expose only checkpoint serialization ([241c041](https://github.com/Ez-Kits/sync/commit/241c0418c7c92d0ffb408cf9847b14650e540fdd))
* **storage-coordination:** implement coordinated storage with mutex and protocol handling ([9741894](https://github.com/Ez-Kits/sync/commit/9741894665f4a93e1215f1db9d053a22bd82a189))
* **sync:** enforce crash-safe atomic local mutations ([cb9a3d6](https://github.com/Ez-Kits/sync/commit/cb9a3d659cc2d5aae5a3003907f7fb8b56a5d9ff))
* **sync:** introduce SyncAdapter API and update DB adapters for production readiness ([539c413](https://github.com/Ez-Kits/sync/commit/539c413b1234fb88b76931170cbd0476764d4630))


### Bug Fixes

* accept stored collections and policies, infer custom adapters, stabilize useLiveQuery, drop pendingEvents and keep delete id types ([5642849](https://github.com/Ez-Kits/sync/commit/564284913099561aaac52e9b0112481e4bbc3f8d))
* store checkpoints and skipped remote events in the database ([b322bb8](https://github.com/Ez-Kits/sync/commit/b322bb84861131ae57b8a88ca1e423341691afac))
* **sync:** recognise a retried mutation by a durable record of its event id ([0eac801](https://github.com/Ez-Kits/sync/commit/0eac80192f569415f470bb851d6ef4c694b6f3a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ez-kits/sync-client-core bumped to 0.1.0
