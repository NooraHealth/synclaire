# Synclaire progress

25 November 2026. The library is built and checked against WatermelonDB 0.27.1 and the hep backend (iOS simulator + Android emulator). Backend probe scenarios S1–S8 pass for all four countries. hep-unified-frontend has replaced WatermelonDB with a vendored Synclaire tarball (`yarn synclaire:pack`). Frontend Jest CI is green on Node 22. Device Maestro E2E (India + Nepal) and Watermelon→Synclaire upgrade gates are green on iOS simulator and Android emulator. Remaining work is npm publish, physical-device check, and a few library/backend follow-ups.

## Library

- [x] Local database on expo-sqlite: schema, migrations, typed queries, writes, sync, React hooks
- [x] Same sync wire format and SQLite layout as WatermelonDB (`local_storage`, `PRAGMA user_version`); Watermelon files open in place
- [x] Node driver (`better-sqlite3`) for tests/benchmarks; Expo driver for apps
- [x] Unit, differential and property tests vs WatermelonDB; file round-trips for IN / BD / ID / NP
- [x] Backend scenarios S1–S8 against real hep backend for India, Nepal, Bangladesh, and Indonesia
- [x] Expo example app + bare RN 0.83 app; device-suite verified on iOS simulator and Pixel API 34 emulator (IN + NP)
- [x] Node benchmarks vs WatermelonDB (Synclaire faster on measured cases)
- [x] README: API, WatermelonDB mapping, deliberate differences, known backend issues
- [x] Frontend Watermelon fixtures exporter (`npm run fixtures:frontend`)
- [ ] Physical Android phone (emulator uses `10.0.2.2`; a real device needs a reachable host address)
- [ ] Cache prepared statements in the expo-sqlite driver (Node driver already does)
- [ ] Publish Synclaire to npm (still private / vendored tarball)

Deliberate differences from WatermelonDB (kept on purpose):

- [x] `markDeleted` on a never-synced row deletes immediately (`deleteCreatedImmediately: false` restores Watermelon)
- [x] Second concurrent `synchronize` throws `SyncAlreadyRunningError`
- [x] `onConflict` reports merges and remote deletes
- [x] No in-memory record cache; error message text may differ

## Frontend migration (hep-unified-frontend)

- [x] Replace WatermelonDB with Synclaire in app code
- [x] Vendor Synclaire as `file:./vendor/synclaire-*.tgz` (`yarn synclaire:pack`); no `SYNCLAIRE_TOKEN` / GitHub pack
- [x] Metro → src, Jest/tsc → dist; `synclaire/testing` → BetterSqliteDriver; `better-sqlite3` as frontend devDependency
- [x] Upgrade-in-place Jest (`src/model/upgradeInPlace.test.ts` + watermelon fixtures)
- [x] Writer / query / SyncContextProvider integration tests
- [x] Offline-database testing strategy doc (`docs/testing/offline-database.md`)
- [x] Maestro mobile E2E scaffolding (`e2e/mobile/`: flows, seed, upgrade.sh, backends on 8775/8776)
- [x] iOS Maestro flows verified locally (India + Nepal ports)
- [x] CI Jest green on Node 22.23.2 (fixed better-sqlite3 SIGSEGV on Node 20; SyncContext timeouts under coverage)
- [x] Android Maestro E2E green (India + Nepal; R8 off for local e2e, Sentry upload skipped)
- [x] Full iOS Maestro orchestrator run as a release gate (India + Nepal)
- [x] Device upgrade from main’s WatermelonDB build (`yarn e2e:mobile:upgrade`) on iOS and Android
- [ ] Merge frontend PR #292 (ready for review; CI + local Maestro/upgrade gates green; awaiting `@hep-unified-frontend-owners`); replace vendored tarball with npm package once Synclaire is published
- [x] `validate-linear-branch` CI check (branch naming; unrelated to Synclaire)

## Backend (hep-unified-backend)

Known issues Synclaire currently matches WatermelonDB on — fixing them will fail a scenario until expected behaviour is updated:

- [ ] Device-clock `updated_at`
- [ ] Untagged sessions
- [ ] Remote delete overriding local edits
- [ ] Pull timestamp race

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
| `example/` | Expo SDK 55 dev-client app. `npm run example:ios`, `npm run example:android` |
| `example-bare/` | Bare React Native 0.83 app, still on `expo-sqlite`. `npm run example:bare:ios`, `npm run example:bare:android` |
| `scripts/` | Backend up/down, Watermelon fixture builder, frontend fixture export, device control server (port 8799), iOS/Android runners |
| `README.md` | API, WatermelonDB mapping, differences, backend issues, how to run each check |

Commands: `npm run check`, `npm run test:backend`, `npm run fixtures:frontend`, `npm run example:ios`, `npm run example:android`, `npm run example:bare:ios`, `npm run example:bare:android`, `npm run bench`.
