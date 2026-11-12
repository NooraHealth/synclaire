import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import type { Database } from '../db/Database';
import type { Clause } from '../query/Q';
import { queryTables } from '../query/compile';
import type { Row, Schema, TableName } from '../schema/defineSchema';

const DatabaseContext = createContext<Database<Schema> | null>(null);

export function SynclaireProvider<S extends Schema>({
  database,
  children,
}: {
  database: Database<S>;
  children?: ReactNode;
}) {
  return <DatabaseContext.Provider value={database as unknown as Database<Schema>}>{children}</DatabaseContext.Provider>;
}

export function useDatabase<S extends Schema = Schema>(): Database<S> {
  const db = useContext(DatabaseContext);
  if (!db) throw new Error('[synclaire] useDatabase must be used inside <SynclaireProvider>');
  return db as unknown as Database<S>;
}

/**
 * Calls `callback` after every committed transaction that touched one of `tables`.
 * Replaces `collection.query().observe().subscribe(refetch)`.
 */
export function useTableChanges(tables: readonly string[], callback: () => void): void {
  const db = useDatabase();
  const cbRef = useRef(callback);
  cbRef.current = callback;
  const key = [...tables].sort().join(',');
  useEffect(() => {
    const watched = new Set(key.split(','));
    return db.onChange(changed => {
      for (const t of changed) {
        if (watched.has(t)) {
          cbRef.current();
          return;
        }
      }
    });
  }, [db, key]);
}

export interface QueryState<T> {
  data: T;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

function useAsyncValue<T>(initial: T, load: () => Promise<T>, tables: readonly string[], deps: string): QueryState<T> {
  const [state, setState] = useState<{ data: T; isLoading: boolean; error: Error | null }>({
    data: initial,
    isLoading: true,
    error: null,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const run = useRef(() => {
    const gen = ++generation.current;
    loadRef.current().then(
      data => {
        if (gen === generation.current) setState({ data, isLoading: false, error: null });
      },
      (error: unknown) => {
        if (gen === generation.current) {
          setState(s => ({ ...s, isLoading: false, error: error instanceof Error ? error : new Error(String(error)) }));
        }
      },
    );
  }).current;

  useEffect(() => {
    setState(s => ({ ...s, isLoading: true }));
    run();
    return () => {
      generation.current += 1;
    };
  }, [deps, run]);

  useTableChanges(tables, run);
  return { ...state, refetch: run };
}

/**
 * Runs a query and re-runs it whenever a table it depends on changes. `deps` must change when
 * the clauses change (clauses are compared by their serialized form by default).
 */
export function useQuery<S extends Schema, T extends TableName<S>>(
  table: T,
  clauses: readonly Clause[] = [],
  deps?: readonly unknown[],
): QueryState<Row<S, T>[]> {
  const db = useDatabase<S>();
  const key = JSON.stringify([table, deps ?? clauses]);
  return useAsyncValue<Row<S, T>[]>(
    [],
    () => db.query(table, ...clauses),
    [...queryTables(table, clauses)],
    key,
  );
}

export function useCount<S extends Schema, T extends TableName<S>>(
  table: T,
  clauses: readonly Clause[] = [],
  deps?: readonly unknown[],
): QueryState<number> {
  const db = useDatabase<S>();
  const key = JSON.stringify([table, deps ?? clauses]);
  return useAsyncValue(0, () => db.count(table, ...clauses), [...queryTables(table, clauses)], key);
}

export function useRecord<S extends Schema, T extends TableName<S>>(
  table: T,
  id: string | null | undefined,
): QueryState<Row<S, T> | null> {
  const db = useDatabase<S>();
  return useAsyncValue<Row<S, T> | null>(
    null,
    () => (id ? db.get(table, id) : Promise.resolve(null)),
    [table],
    JSON.stringify([table, id ?? null]),
  );
}
