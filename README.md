# Synclaire

Synclaire is an offline-first local database and sync engine for React Native, built on
expo-sqlite. It replaces WatermelonDB in hep-unified-frontend without any backend change: it
speaks the same `/api/v1/sync/` protocol and opens existing WatermelonDB database files in place,
including their unpushed changes and last-pulled timestamp.

- Plain, frozen, typed row objects. No decorators, no model classes, no observables.
- A small typed query builder (`Q`) that compiles to parameterised SQL.
- Sync semantics copied from WatermelonDB 0.27.1 and checked against it by differential and
  property tests; the few deliberate differences are listed [below](#deliberate-differences-from-watermelondb).

## Contents

- [Setup](#setup)
- [Reading and querying](#reading-and-querying)
- [Writing](#writing)
- [Sync](#sync)
- [React](#react)
- [WatermelonDB to Synclaire mapping](#watermelondb-to-synclaire-mapping)
- [Deliberate differences from WatermelonDB](#deliberate-differences-from-watermelondb)
- [Known backend issues](#known-backend-issues)
- [Verification](#verification)
- [Benchmarks](#benchmarks)
- [Repository layout](#repository-layout)
- [Code samples](./EXAMPLES.md) — copy-paste examples for schema, open, query, write, sync, React, and tests

## Setup

### Schema

Column names are the SQLite/wire column names (`snake_case`). Every table also gets `id`,
`_status` and `_changed`, exactly like WatermelonDB, so the generated DDL is byte-identical to
WatermelonDB's for the same schema.

```ts
import { col, defineSchema, defineMigrations, addColumns } from 'synclaire';

export const schema = defineSchema({
  version: 3,
  tables: {
    patient_sessions: {
      columns: {
        date: col.number(),
        created_at: col.number(),
        updated_at: col.number(),
        created_by: col.string(),
        location: col.string().optional(),
        class_type: col.string(),
        no_of_patients: col.number(),
        feedback: col.string().optional(),
        // ...
      },
      associations: { patient_session_nurses: { type: 'has_many', foreignKey: 'session_id' } },
      // Stamp created_at/updated_at from the device clock, like Watermelon's @readonly @date fields.
      timestamps: true,
    },
    nurses: { columns: { name: col.string(), privacy_consent_timestamp: col.number().optional() /* ... */ } },
    patient_session_nurses: {
      columns: { session_id: col.string().indexed(), nurse_id: col.string().indexed() },
      associations: {
        patient_sessions: { type: 'belongs_to', key: 'session_id' },
        nurses: { type: 'belongs_to', key: 'nurse_id' },
      },
    },
  },
});

export const migrations = defineMigrations([
  { toVersion: 2, steps: [addColumns('patient_sessions', { no_of_patients: col.number(), time_slot: col.string() })] },
  { toVersion: 3, steps: [addColumns('nurses', { privacy_consent_timestamp: col.number().optional() })] },
]);
```

Migration steps are `addColumns`, `createTable` and `unsafeExecuteSql`. They produce the same SQL
as WatermelonDB's migrations and run in one transaction. The schema version lives in
`PRAGMA user_version`, as in WatermelonDB. Opening a file whose version is newer than the schema
throws `SchemaTooNewError`; a missing migration path throws `MigrationPathError`.

### Opening a database (Expo)

```ts
import { Platform } from 'react-native';
import { Paths } from 'expo-file-system';
import { openDatabase } from 'synclaire';
import { openExpoSqliteDriver, watermelonDatabaseLocation } from 'synclaire/expo';

// Open the file WatermelonDB created (dbName as passed to its SQLiteAdapter, e.g. `in_<userId>`).
const location = watermelonDatabaseLocation({
  platform: Platform.OS as 'ios' | 'android',
  dbName,
  documentDirectory: Paths.document.uri,
});
const driver = await openExpoSqliteDriver(location); // { databaseName, directory }
const db = await openDatabase({ driver, schema, migrations });
db.setup; // { action: 'created' | 'migrated' | 'none', fromVersion, toVersion }
```

WatermelonDB keeps its file at `Documents/<dbName>.db` on iOS and `/data/data/<pkg>/<dbName>.db`
on Android; `watermelonDatabaseLocation` returns those paths. The driver opens one connection per
file, enables WAL and a busy timeout, and runs every write in an exclusive transaction.

`openDatabase` options:

| Option | Default | Purpose |
| --- | --- | --- |
| `now` | `Date.now` | Clock for `created_at`/`updated_at` stamps |
| `generateId` | UUID v4 | Ids for inserts without an explicit `id` |
| `deleteCreatedImmediately` | `true` | `markDeleted` on a never-synced row deletes it immediately (see differences) |

In Node (tests, scripts), use `BetterSqliteDriver` from `synclaire/testing`.

## Reading and querying

```ts
import { Q } from 'synclaire';

const session = await db.find('patient_sessions', id); // throws RecordNotFoundError
const maybe = await db.get('patient_sessions', id); // or null
session.feedback; // string | null, typed from the schema
session.syncStatus; // 'synced' | 'created' | 'updated' | 'deleted'

const mine = await db.query(
  'patient_sessions',
  Q.on('patient_session_nurses', 'nurse_id', nurseId),
  Q.where('date', Q.gte(from)),
  Q.sortBy('date', 'desc'),
  Q.take(50),
  Q.skip(page * 50),
);
const total = await db.count('patient_sessions', Q.where('class_type', Q.oneOf(types)));
```

Operators: `Q.eq`, `notEq`, `gt`, `gte`, `lt`, `lte`, `oneOf`, `notIn`, `between`, `like`,
`notLike`, `isNull`, `isNotNull`, and `sanitizeLikeString` for `like` patterns. Combine conditions
with `Q.and` and `Q.or`. `Q.on(table, column, value)` or `Q.on(table, [conditions])` joins through
an association, ignoring deleted rows in the joined table. Pagination works as in WatermelonDB:
`Q.take(0)` means no limit, and `Q.skip` only applies together with `Q.take`.

`query` and `count` exclude rows marked deleted; `find` and `get` return them, as in WatermelonDB.
Rows are frozen snapshots; they don't update themselves (use the React hooks or `db.onChange`).

## Writing

All writes go through `db.write`, which runs one SQLite transaction and queues behind other
writes. Change listeners fire once per committed transaction.

```ts
await db.write(async tx => {
  const s = await tx.insert('patient_sessions', { date: Date.now(), class_type, created_by: nurseId, no_of_patients: 0 });
  await tx.insert('patient_session_nurses', { session_id: s.id, nurse_id: nurseId });
  await tx.update('patient_sessions', s.id, { feedback: 'Good turnout' });
  await tx.markDeleted('patient_sessions', otherId);
  await tx.markDeletedWhere('patient_session_nurses', Q.where('session_id', otherId));
});
```

- `insert` fills omitted columns with WatermelonDB's defaults (`''`, `0`, `false`, or `null` for
  optional columns) and marks the row `created`.
- `update` records only the columns whose values actually change in `_changed`, and stamps
  `updated_at` first on tables with `timestamps`. Setting a column on a deleted row throws
  `DeletedRecordError`.
- `markDeleted` and `markDeletedWhere` mark rows deleted so the next push sends the deletion.
- `destroyPermanently` and `destroyPermanentlyWhere` remove rows without syncing the deletion.
- The `tx` handle can't be used after the callback finishes (`TransactionFinishedError`).

Also available:

- `db.read(fn)`: a consistent read inside the write queue.
- `db.localStorage.get/set/remove`: the `local_storage` table, holding raw string values.
- `db.reset()`: drops and recreates all tables. An in-flight sync then fails with `SyncDatabaseResetError`.
- `db.onChange(tables => ...)`: subscribe to committed changes.
- `db.close()`.

## Sync

```ts
import { synchronize, hasUnsyncedChanges, SyncLogger } from 'synclaire';

const logger = new SyncLogger(10);
await synchronize({
  database: db,
  sendCreatedAsUpdated: true,
  log: logger.newLog(),
  pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
    const res = await api.get('/sync/', { params: { last_pulled_at: lastPulledAt, schema_version: schemaVersion, migration } });
    return { changes: res.changes, timestamp: res.timestamp };
  },
  pushChanges: async ({ changes, lastPulledAt }) => {
    await api.post(`/sync/?last_pulled_at=${lastPulledAt}`, changes);
  },
  onConflict: conflict => {
    // conflict.type === 'merge': remote values merged into a locally changed row (per column)
    // conflict.type === 'remoteDelete': server deleted a row that had unpushed local edits
  },
});
await hasUnsyncedChanges({ database: db });
```

This follows WatermelonDB's algorithm step by step:

1. Pull changes since `__watermelon_last_pulled_at`.
2. Apply them in one transaction. Remote rows are merged per column into locally changed rows, and rows deleted locally stay deleted. Tables and columns the schema doesn't know are skipped.
3. Save the new timestamp, plus the schema version on the first sync.
4. Collect local changes. Push them with full raw rows, including `_status`/`_changed`.
5. Mark the pushed rows as synced, but only rows that didn't change during the push. `experimentalRejectedIds` are respected.

Calling `synchronize` again while a sync is running throws `SyncAlreadyRunningError`.

## React

```tsx
import { SynclaireProvider, useDatabase, useQuery, useCount, useRecord } from 'synclaire/react';

<SynclaireProvider database={db}><App /></SynclaireProvider>;

function SessionList({ nurseId }: { nurseId: string }) {
  const { data: sessions, isLoading, error, refetch } = useQuery(
    'patient_sessions',
    [Q.on('patient_session_nurses', 'nurse_id', nurseId), Q.sortBy('date', 'desc')],
  );
  const { data: count } = useCount('patient_sessions');
  // ...
}

function SessionRow({ id }: { id: string }) {
  const { data: session } = useRecord('patient_sessions', id);
  // ...
}
```

Hooks re-run when a table the query depends on changes, including tables joined with `Q.on`.
`useTableChanges(tables, callback)` is the low-level building block.

## WatermelonDB to Synclaire mapping

This covers every WatermelonDB call used in hep-unified-frontend.

| WatermelonDB | Synclaire |
| --- | --- |
| `new Database({ adapter: new SQLiteAdapter({ dbName, schema, migrations }), modelClasses })` | `openDatabase({ driver: await openExpoSqliteDriver(watermelonDatabaseLocation(...)), schema, migrations })` |
| `appSchema` / `tableSchema` / Model classes with decorators | `defineSchema` with `col.*`; rows are typed from it |
| `schemaMigrations({ migrations })` / `addColumns` | `defineMigrations([...])` / `addColumns(table, { col: col.number() })` |
| `database.write(async () => ...)` | `db.write(async tx => ...)` |
| `database.get(table).create(r => { r.field = v })` | `tx.insert(table, { column: v })` |
| `record.update(r => { r.field = v })` | `tx.update(table, id, { column: v })` |
| `collection.find(id)` | `db.find(table, id)` / `tx.find(table, id)` (`get` returns `null` instead of throwing) |
| `collection.query(...clauses).fetch()` / `.fetchCount()` | `db.query(table, ...clauses)` / `db.count(table, ...clauses)` |
| `Q.where`, `Q.and`, `Q.or`, `Q.on`, `Q.sortBy`, `Q.take`, `Q.skip`, `Q.oneOf`, `Q.gte`, ... | Same names on `Q`; `Q.sortBy(col, 'desc')` instead of `Q.desc` |
| `record.markAsDeleted()` | `tx.markDeleted(table, id)` |
| `query.markAllAsDeleted()` | `tx.markDeletedWhere(table, ...clauses)` |
| `record.destroyPermanently()` / `query.destroyAllPermanently()` | `tx.destroyPermanently(table, id)` / `tx.destroyPermanentlyWhere(table, ...clauses)` |
| `database.write(() => database.unsafeResetDatabase())` | `db.reset()` (outside `write`; it waits for queued writes) |
| `synchronize({ database, pullChanges, pushChanges, sendCreatedAsUpdated, log })` | `synchronize({...})` with the same arguments, plus `onConflict` |
| `hasUnsyncedChanges({ database })` | `hasUnsyncedChanges({ database: db })` |
| `new SyncLogger()` / `logger.newLog()` | Same API, from `synclaire` |
| `record.syncStatus` / `record._raw._status` | `row.syncStatus` |
| `withObservables(['session'], ({ session }) => ({ session, nurses: ... }))` | `useRecord(table, id)` / `useQuery(table, clauses)` inside the component |
| `useDatabase()` / `DatabaseProvider` | `useDatabase()` / `SynclaireProvider` from `synclaire/react` |
| `database.localStorage.get/set` | `db.localStorage.get/set` (string values) |

Rows use column names and stored types: `session.no_of_patients`, not `session.noOfPatients`, and
`session.date` is epoch milliseconds, not a `Date`. Map these in the app's own types if camelCase
or `Date` objects are wanted.

For example, `useDeleteSession` in hep-unified-frontend:

```ts
// WatermelonDB
await database.write(async () => {
  const session = await sessions.find(sessionId);
  session.markAsDeleted();
  await sessionNurses.query(Q.where('session_id', sessionId)).markAllAsDeleted();
});

// Synclaire
await db.write(async tx => {
  await tx.markDeleted('patient_sessions', sessionId);
  await tx.markDeletedWhere('patient_session_nurses', Q.where('session_id', sessionId));
});
```

## Deliberate differences from WatermelonDB

Everything else matches WatermelonDB 0.27.1: database contents, push payloads, sync outcomes and
`hasUnsyncedChanges`. These are the only differences the differential tests allow:

1. **`markDeleted` on a never-synced (`created`) row deletes it immediately.** WatermelonDB keeps
   it as `deleted` until the next push, which then sends the id of a record the server has never
   seen. Pass `deleteCreatedImmediately: false` to restore WatermelonDB's behaviour; the
   differential tests run in that mode.
2. **A second concurrent `synchronize` throws `SyncAlreadyRunningError`.** WatermelonDB only warns
   and lets both run.
3. **`onConflict` reports merges and remote deletes.** WatermelonDB applies them silently, apart
   from logging merges in `log.resolvedConflicts`, which Synclaire also fills.
4. **Error messages differ.** The same operations fail; only the text is different.
5. **There's no record cache.** WatermelonDB's `collection.find` can return a cached record that
   sync has already removed from SQLite after pushing its deletion. Synclaire throws
   `RecordNotFoundError` in that case.
6. **The API is different.** Rows are immutable snapshots rather than live models: there are no
   observables, lazy relations or `prepare*`/`batch` calls. All writes inside one `db.write` share
   a single transaction instead.

## Known backend issues

The probe scenarios found these against hep-unified-backend. They affect WatermelonDB and
Synclaire equally. Synclaire keeps WatermelonDB's behaviour so the backend can be fixed
separately, and the scenario suite asserts the current behaviour so a fix will show up as a
failing check.

- **`updated_at` comes from the device clock.** Incremental pulls and the push conflict check
  compare server timestamps against `updated_at` values that devices set.
  - If a device's clock is behind (scenario S7), its edits are saved with an old `updated_at`.
    Other devices' incremental pulls never return them.
  - If a device's clock is ahead (scenario S8), the server row's `updated_at` ends up in the
    future. Every later push touching that row is rejected with HTTP 400 until real time catches
    up.
- **Untagged sessions are still returned.** A nurse keeps receiving a session after being removed
  from it, because the nurse filter doesn't exclude sessions without a live link (scenario S7).
  Pulls also include the nurse's link rows on soft-deleted sessions, even though the sessions
  themselves aren't sent (scenario S1).
- **Remote deletes override local edits.** A server-side soft delete removes the row locally even
  when it has unpushed edits, so those edits are lost (scenario S6). Synclaire reports this through
  `onConflict` with `type: 'remoteDelete'`.
- **The pull timestamp races with writes.** The server takes the pull `timestamp` after running
  its queries. A row written in that gap isn't in this pull, and its `updated_at` is older than the
  new `last_pulled_at`, so the next incremental pull misses it too.
- **Server edits between pull and push.** A server edit made after a device's pull rejects the
  whole push with HTTP 400 (scenario S5). Retrying the sync, which pulls again, succeeds. This is
  expected behaviour, but the app should retry.

## Verification

```sh
npm run check            # typecheck, lint, unit + differential tests
npm run test:backend     # real hep-unified-backend (Docker Postgres + Django), all four countries
npm run example:ios          # Expo example app on the iOS simulator against the same backend
npm run example:android      # the same checks on an Android emulator
npm run example:bare:ios     # the same checks in a bare React Native app, still on expo-sqlite
npm run example:bare:android # the bare app on an Android emulator
npm run bench                # Node benchmarks vs WatermelonDB
```

- **Unit tests** cover the drivers, schema and DDL, migrations, writes, queries, sync and the
  React hooks. The generated DDL and migration SQL are checked byte-for-byte against WatermelonDB
  for all four country schemas: India, Bangladesh, Indonesia and Nepal.
- **Differential tests** (`test/differential`) run the same operations through WatermelonDB 0.27.1
  and Synclaire, then compare database dumps, push payloads, outcomes and `hasUnsyncedChanges`
  after every step. The probe payloads captured from the real backend are replayed, and a
  fast-check property test generates random interleavings against a model server. Those
  interleavings include failed pushes, edits racing a push, remote deletes and resets.
  `SYNCLAIRE_PROPERTY_RUNS` sets the number of runs; `SYNCLAIRE_PROPERTY_SEED` and
  `SYNCLAIRE_PROPERTY_PATH` replay a failure.
- **Round-trip tests** cover all four countries:
  - a WatermelonDB file with pending changes is opened and synced by Synclaire, then reopened by
    WatermelonDB;
  - a WatermelonDB v1 file is migrated in place;
  - WatermelonDB opens a file that Synclaire created.
- **Backend integration** (`scenarios/probe.ts`, `test/integration`): scenarios S1–S8 run with two
  nurses against the real backend for India, Nepal, Bangladesh, and Indonesia.
  - `scripts/backend-up.sh` starts Postgres in Docker, migrates and seeds one database per
    country (default: all four; override with `COUNTRIES="India Nepal"`), and runs the Django
    dev servers (ports 8765–8768). Indonesia uses `no_of_participants` for the S2/S4 count
    column because its client schema has no `no_of_patients`.
  - `scripts/backend-down.sh` stops them.
  - The backend checkout is expected at `../hep-unified-backend`; set `BACKEND_DIR` otherwise.
- **Example app** (`example/`, Expo SDK 55, React Native 0.83): the app runs the same scenario
  file on device storage through `ExpoSqliteDriver`.
  - It places a WatermelonDB-generated file with unpushed changes at WatermelonDB's native
    location, then opens and syncs it.
  - `npm run fixtures:watermelon` builds that file.
  - It also runs on-device benchmarks.
  - The host control server (`npm run example:control`) applies server-side edits and collects
    the reports.
  - `npm run example:ios` does the whole run on a simulator. It builds a Release configuration so
    the JavaScript is embedded and no dev-client prompt appears. For interactive use, run
    `npx expo run:ios` in `example/`.
  - Verified: all checks pass on the iPhone 17 Pro simulator (iOS 26.2) for India and Nepal.
  - `npm run example:android` boots `Pixel_API_34` when no device is online (`ANDROID_AVD` to
    override), reseeds the backend, builds a Release APK for `arm64-v8a` (`ANDROID_ABIS` to
    override) and waits for `example/reports/android-*.json`.
  - Verified: all five reports pass on the Pixel API 34 emulator (arm64) for India and Nepal.
  - The emulator reaches the host as `10.0.2.2`. Django's local `ALLOWED_HOSTS` includes that
    name. Prebuild does not apply `android.usesCleartextTraffic`, so
    `example/plugins/withCleartextTraffic.js` sets it on the release manifest.
  - expo-file-system only writes under `files/` and `cache/`. The WatermelonDB file on Android
    lives in the app data directory, the parent of `files/`. The check downloads the fixture
    into cache and has SQLite write it into place with `VACUUM INTO`.
- **Bare React Native** (`example-bare/`, React Native 0.83, no Expo prebuild or dev client). It
  runs the same checks as the Expo example. The screen and tasks live in `device-suite/` and both
  apps import them. SQLite is still `expo-sqlite`, installed with the `expo` package the way a
  bare app has to. Reports are `example/reports/bare-ios-*.json`, so they do not overwrite the
  Expo app's reports.
  - Hermes has no `crypto.randomUUID`. The entry file imports `react-native-get-random-values`
    first, which is what `uuidv4` uses. Without that import, ids fall back to `Math.random`.
  - `npm run example:bare:ios` reseeds the backend, builds a Release app (the JS bundle is
    embedded) and runs it on a simulator.
  - Verified: all five reports pass on the iPhone 17 Pro simulator (iOS 26.2) for India and Nepal.
    `expo-sqlite` also needs `expo-asset`, which the app depends on directly.
  - `npm run example:bare:android` is the same run as the Expo Android script. Reports are
    `example/reports/bare-android-*.json`.
  - `android/app/src/main/res/xml/network_security_config.xml` allows cleartext to `10.0.2.2`
    and `127.0.0.1`. Release builds turn the global cleartext flag off; that domain list is
    what the emulator uses.
  - Verified: all five reports pass on the Pixel API 34 emulator (arm64) for India and Nepal.

## Benchmarks

Node, both libraries on better-sqlite3 with file-backed databases and the India schema
(`npm run bench`, median of 9 runs, Apple Silicon, Node 22):

| Case | Synclaire (ms) | WatermelonDB (ms) | Speed-up |
| --- | ---: | ---: | ---: |
| First pull: apply 5,000 created sessions | 35 | 78 | 2.2x |
| Incremental pull: apply 5,000 updated sessions | 40 | 78 | 1.9x |
| Insert 1,000 sessions in one write | 6 | 11 | 1.8x |
| Push 1,000 local changes | 6 | 22 | 3.5x |
| 100 pages of 50 sessions sorted by date (5,000 rows) | 332 | 654 | 2.0x |

On the iOS simulator through expo-sqlite (example app, Release build):

| Case | ms |
| --- | ---: |
| Insert 2,000 sessions in one write | ~390 |
| First pull: 5,000 sessions + 5,000 links | ~1,600 |
| 100 pages of 50 sessions sorted by date | ~450 |
| Count sessions joined to a nurse (`Q.on`) | ~470 |

One Release run on the Pixel API 34 emulator, through expo-sqlite (example app):

| Case | ms |
| --- | ---: |
| Insert 2,000 sessions in one write | 5,107 |
| First pull: 5,000 sessions + 5,000 links | 23,442 |
| 100 pages of 50 sessions sorted by date | 2,294 |
| Count sessions joined to a nurse (`Q.on`) | 2,005 |

The expo driver doesn't cache prepared statements yet; the Node driver does. Adding a cache there
is the obvious next optimisation if on-device write throughput matters.

## Repository layout

```
src/            library: schema, migrations, db (Database, WriteTx), query, sync, react, expo, testing
scenarios/      platform-neutral country schemas and backend probe scenarios (Node + device apps)
device-suite/   on-device checks shared by the Expo example and the bare app
test/           unit, differential, integration suites; fixtures (probe payloads, Watermelon oracle)
bench/          Node benchmarks vs WatermelonDB
scripts/        backend up/down, Watermelon fixture builder, device control server, iOS and Android runners
example/        Expo dev-client app
example-bare/   bare React Native app, still using expo-sqlite
```
