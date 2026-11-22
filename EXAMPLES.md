# Synclaire code samples

Copy-paste oriented examples. Full API notes live in [README.md](./README.md).

## Schema and migrations

```ts
import { col, defineSchema, defineMigrations, addColumns, createTable } from 'synclaire';

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
      },
      associations: {
        patient_session_nurses: { type: 'has_many', foreignKey: 'session_id' },
      },
      timestamps: true, // stamps created_at / updated_at like Watermelon @date
    },
    nurses: {
      columns: {
        name: col.string(),
        privacy_consent_timestamp: col.number().optional(),
      },
    },
    patient_session_nurses: {
      columns: {
        session_id: col.string().indexed(),
        nurse_id: col.string().indexed(),
      },
      associations: {
        patient_sessions: { type: 'belongs_to', key: 'session_id' },
        nurses: { type: 'belongs_to', key: 'nurse_id' },
      },
    },
  },
});

export const migrations = defineMigrations([
  {
    toVersion: 2,
    steps: [
      addColumns('patient_sessions', {
        no_of_patients: col.number(),
        time_slot: col.string(),
      }),
    ],
  },
  {
    toVersion: 3,
    steps: [
      addColumns('nurses', {
        privacy_consent_timestamp: col.number().optional(),
      }),
    ],
  },
]);
```

## Open a database (Expo / React Native)

Opens the same file path WatermelonDB used, so an existing install upgrades in place.

```ts
import { Platform } from 'react-native';
import { Paths } from 'expo-file-system';
import { openDatabase } from 'synclaire';
import { openExpoSqliteDriver, watermelonDatabaseLocation } from 'synclaire/expo';
import { schema, migrations } from './schema';

export async function openAppDatabase(dbName: string) {
  const location = watermelonDatabaseLocation({
    platform: Platform.OS as 'ios' | 'android',
    dbName, // e.g. `in_${userId}`
    documentDirectory: Paths.document.uri,
  });
  const driver = await openExpoSqliteDriver(location);
  const db = await openDatabase({ driver, schema, migrations });
  // db.setup → { action: 'created' | 'migrated' | 'none', fromVersion, toVersion }
  return db;
}
```

## Open a database (Node / Jest)

```ts
import { openDatabase } from 'synclaire';
import { BetterSqliteDriver } from 'synclaire/testing';
import { schema, migrations } from './schema';
import { v4 as uuidv4 } from 'uuid';

export async function createTestDatabase() {
  return openDatabase({
    driver: new BetterSqliteDriver({ path: ':memory:' }),
    schema,
    migrations,
    generateId: uuidv4,
  });
}
```

## Read and query

```ts
import { Q } from 'synclaire';

// By id
const session = await db.find('patient_sessions', id); // throws RecordNotFoundError
const maybe = await db.get('patient_sessions', id); // null if missing
session.feedback; // typed from schema
session.syncStatus; // 'synced' | 'created' | 'updated' | 'deleted'

// Filtered list
const mine = await db.query(
  'patient_sessions',
  Q.on('patient_session_nurses', 'nurse_id', nurseId),
  Q.where('date', Q.gte(from)),
  Q.where('class_type', Q.oneOf(['ANC', 'PNC'])),
  Q.sortBy('date', 'desc'),
  Q.take(50),
  Q.skip(page * 50),
);

const total = await db.count(
  'patient_sessions',
  Q.where('feedback', Q.isNotNull()),
);

// Compound conditions
const matches = await db.query(
  'patient_sessions',
  Q.or(
    Q.where('location', Q.like(Q.sanitizeLikeString('%clinic%'))),
    Q.where('no_of_patients', Q.gte(20)),
  ),
);
```

## Write

All mutations go through one `db.write` transaction.

```ts
import { Q } from 'synclaire';

await db.write(async tx => {
  const s = await tx.insert('patient_sessions', {
    date: Date.now(),
    class_type: 'ANC',
    created_by: nurseId,
    no_of_patients: 0,
  });

  await tx.insert('patient_session_nurses', {
    session_id: s.id,
    nurse_id: nurseId,
  });

  await tx.update('patient_sessions', s.id, {
    feedback: 'Good turnout',
    no_of_patients: 12,
  });
});

// Soft-delete (pushed on next sync)
await db.write(async tx => {
  await tx.markDeleted('patient_sessions', sessionId);
  await tx.markDeletedWhere(
    'patient_session_nurses',
    Q.where('session_id', sessionId),
  );
});

// Hard-delete (not synced)
await db.write(async tx => {
  await tx.destroyPermanently('patient_sessions', orphanId);
  await tx.destroyPermanentlyWhere(
    'patient_session_nurses',
    Q.where('session_id', orphanId),
  );
});
```

### Local storage, reset, change events

```ts
await db.localStorage.set('last_screen', 'sessions');
const screen = await db.localStorage.get('last_screen'); // string | null
await db.localStorage.remove('last_screen');

const unsubscribe = db.onChange(tables => {
  if (tables.has('patient_sessions')) refetchSessions();
});

await db.reset(); // drops + recreates tables; in-flight sync → SyncDatabaseResetError
await db.close();
```

## Sync

```ts
import {
  synchronize,
  hasUnsyncedChanges,
  SyncLogger,
  SyncAlreadyRunningError,
} from 'synclaire';

const logger = new SyncLogger(10);

async function sync(db: Database, api: ApiClient) {
  try {
    await synchronize({
      database: db,
      sendCreatedAsUpdated: true, // hep backend expects this
      log: logger.newLog(),
      pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
        const res = await api.get('/api/v1/sync/', {
          params: {
            last_pulled_at: lastPulledAt,
            schema_version: schemaVersion,
            migration: encodeURIComponent(JSON.stringify(migration)),
          },
        });
        return { changes: res.changes, timestamp: res.timestamp };
      },
      pushChanges: async ({ changes, lastPulledAt }) => {
        await api.post('/api/v1/sync/', JSON.stringify(changes), {
          params: { last_pulled_at: lastPulledAt },
        });
      },
      onConflict: conflict => {
        if (conflict.type === 'remoteDelete') {
          // Server deleted a row that still had unpushed local edits
          reportLostEdits(conflict.table, conflict.local.id);
        }
        // conflict.type === 'merge' — per-column merge into a locally changed row
      },
    });
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) return; // another sync in flight
    throw err;
  }
}

const pending = await hasUnsyncedChanges({ database: db });
```

## React

```tsx
import {
  SynclaireProvider,
  useDatabase,
  useQuery,
  useCount,
  useRecord,
} from 'synclaire/react';
import { Q } from 'synclaire';

function Root({ database }: { database: Database }) {
  return (
    <SynclaireProvider database={database}>
      <App />
    </SynclaireProvider>
  );
}

function SessionList({ nurseId }: { nurseId: string }) {
  const { data: sessions, isLoading, error, refetch } = useQuery(
    'patient_sessions',
    [
      Q.on('patient_session_nurses', 'nurse_id', nurseId),
      Q.sortBy('date', 'desc'),
    ],
  );
  const { data: count } = useCount('patient_sessions');

  if (isLoading) return null;
  if (error) return <ErrorView error={error} onRetry={refetch} />;
  return (
    <List
      header={`${count ?? 0} sessions`}
      rows={sessions ?? []}
    />
  );
}

function SessionRow({ id }: { id: string }) {
  const { data: session } = useRecord('patient_sessions', id);
  if (!session || session.syncStatus === 'deleted') return null;
  return <Text>{session.feedback}</Text>;
}

function AddSessionButton({ nurseId }: { nurseId: string }) {
  const db = useDatabase();

  const onPress = () =>
    db.write(async tx => {
      const s = await tx.insert('patient_sessions', {
        date: Date.now(),
        class_type: 'ANC',
        created_by: nurseId,
        no_of_patients: 0,
      });
      await tx.insert('patient_session_nurses', {
        session_id: s.id,
        nurse_id: nurseId,
      });
    });

  return <Button onPress={onPress} title="Add session" />;
}
```

## Test helpers

Seed rows as if they came from a pull (status `synced`):

```ts
import { openDatabase, synchronize } from 'synclaire';
import { BetterSqliteDriver } from 'synclaire/testing';

async function seedSynced(database: Database, rows: Record<string, object[]>) {
  const changes = Object.fromEntries(
    database.schema.tableNames.map(table => [
      table,
      { created: [], updated: rows[table] ?? [], deleted: [] },
    ]),
  );
  await synchronize({
    database,
    sendCreatedAsUpdated: true,
    pullChanges: async () => ({ changes, timestamp: 1000 }),
    pushChanges: async () => {},
  });
}

const db = await openDatabase({
  driver: new BetterSqliteDriver({ path: ':memory:' }),
  schema,
  migrations,
});

await seedSynced(db, {
  patient_sessions: [{ id: 's1', date: 1, class_type: 'ANC', created_by: 'n1' }],
});

await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'ok' }));
expect(await hasUnsyncedChanges({ database: db })).toBe(true);
```

## WatermelonDB → Synclaire (same intent)

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
  await tx.markDeletedWhere(
    'patient_session_nurses',
    Q.where('session_id', sessionId),
  );
});
```

```ts
// WatermelonDB
await database.get('patient_sessions').create(r => {
  r.date = Date.now();
  r.classType = 'ANC';
});

// Synclaire — column names are snake_case wire names
await db.write(async tx => {
  await tx.insert('patient_sessions', {
    date: Date.now(),
    class_type: 'ANC',
    created_by: nurseId,
    no_of_patients: 0,
  });
});
```
