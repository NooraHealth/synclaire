# Synclaire progress

13 November 2026. The library is built and checked against WatermelonDB 0.27.1 and the hep backend. Replacing WatermelonDB inside hep-unified-frontend has not started.

## Implemented

- Local database on expo-sqlite: schema, migrations, typed queries, writes, sync, and React hooks. Rows are plain frozen objects. The query builder is ours.
- Same sync wire format and SQLite file layout as WatermelonDB, including `local_storage` and `PRAGMA user_version`. An existing Watermelon file opens in place, pending changes included.
- Node driver (`better-sqlite3`) for tests and benchmarks. The Expo driver is what the apps use.
- Tests: unit, differential and property tests against WatermelonDB, file round-trips for India, Bangladesh, Indonesia and Nepal, and scenarios S1–S8 against the real backend for India and Nepal.
- Expo example app and a bare React Native 0.83 app. Both run the same checks through `device-suite/` and `expo-sqlite`. Verified on the iOS simulator: in-place open, S1–S8, and on-device benchmarks, for India and Nepal.
- Node benchmarks against WatermelonDB. Synclaire is faster on every case measured (5,000-record pull, 1,000 local inserts, pushing those changes, paged queries).
- README: API, WatermelonDB call mapping, deliberate differences, and the known backend issues (device-clock `updated_at`, untagged sessions, remote delete overriding local edits, pull timestamp race).

Deliberate differences from WatermelonDB, kept on purpose:

- `markDeleted` on a never-synced row deletes it immediately. `deleteCreatedImmediately: false` restores WatermelonDB's behaviour.
- A second concurrent `synchronize` throws `SyncAlreadyRunningError`.
- `onConflict` reports merges and remote deletes.
- Error message text differs. There is no in-memory record cache.

## Left

- **Android, both apps.** The code paths exist (emulator host `10.0.2.2`, Watermelon file location, cleartext HTTP). Nothing has been built or run on an emulator or a device. This machine has no Android emulator or system image, and there is no `example:android` or `example:bare:android` script yet. A physical phone cannot use `10.0.2.2`; that address is only the emulator's name for the host.
- **Backend scenarios for Bangladesh and Indonesia.** The schema round-trip covers all four countries. The live backend suite has only been run for India and Nepal.
- **Frontend migration.** Swap hep-unified-frontend off WatermelonDB onto Synclaire. Out of scope until this library work is accepted.
- **Backend fixes.** The clock, untagged-session, remote-delete, and pull-timestamp issues are in hep-unified-backend. Synclaire matches WatermelonDB's current behaviour so a backend fix will show up as a failing scenario.
- **On-device write speed.** The Node driver caches prepared statements. The expo-sqlite driver does not.

## What is in the project

`synclaire/` is a private Node package (`exports`: `.`, `./expo`, `./react`, `./testing`). Apps resolve the `react-native` condition to TypeScript source. `dist/` is the tsup build for Node.

| Path | What it is |
| --- | --- |
| `src/schema` | Column builders, `defineSchema`, sanitising raw rows, DDL that matches WatermelonDB |
| `src/migrations` | `addColumns`, `createTable`, `unsafeExecuteSql`, setup and version checks |
| `src/db` | `Database`, `WriteTx`, row encoding, `local_storage`, reset, change events |
| `src/query` | `Q` and the SQL compiler |
| `src/sync` | Pull, per-column merge, push, `hasUnsyncedChanges`, `SyncLogger` |
| `src/react` | `SynclaireProvider`, `useDatabase`, `useQuery`, `useCount`, `useRecord` |
| `src/expo` | `ExpoSqliteDriver` and `watermelonDatabaseLocation` |
| `src/testing` | `BetterSqliteDriver` (Node only) |
| `scenarios/` | The four country schemas, and probe scenarios S1–S8, shared by Node and the apps |
| `device-suite/` | The on-device screen and tasks (in-place open, scenarios, benchmarks), shared by both apps |
| `test/unit` | Drivers, schema, migrations, writes, queries, sync, React |
| `test/differential` | Same operations on WatermelonDB and Synclaire, including a fast-check property test |
| `test/integration` | S1–S8 against hep-unified-backend. `scripts/backend-up.sh` starts Postgres and Django |
| `test/fixtures` | Captured probe payloads, and the WatermelonDB schema oracle |
| `bench/run.ts` | Node timings versus WatermelonDB. `npm run bench` |
| `example/` | Expo SDK 55 dev-client app. `npm run example:ios` |
| `example-bare/` | Bare React Native 0.83 app, still on `expo-sqlite`. `npm run example:bare:ios` |
| `scripts/` | Backend up/down, Watermelon fixture builder, device control server (port 8799), the two iOS runners |
| `README.md` | API, WatermelonDB mapping, differences, backend issues, how to run each check |

Commands that are already wired up: `npm run check`, `npm run test:backend`, `npm run example:ios`, `npm run example:bare:ios`, `npm run bench`.
