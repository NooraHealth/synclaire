// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Q, type Database } from '../../src';
import { SynclaireProvider, useCount, useDatabase, useQuery, useRecord, useTableChanges } from '../../src/react';
import { inSchema, type InSchema } from '../fixtures/countries';
import { openTestDb } from '../helpers';

function wrapper(db: Database<InSchema>) {
  return ({ children }: { children: ReactNode }) => <SynclaireProvider database={db}>{children}</SynclaireProvider>;
}

describe('react', () => {
  it('useDatabase throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function C() {
      useDatabase();
      return null;
    }
    expect(() => render(<C />)).toThrow(/SynclaireProvider/);
    spy.mockRestore();
  });

  it('useQuery re-runs after writes to its tables (including joined tables)', async () => {
    const { db } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('patient_sessions', { id: 's1' }));
    const { result } = renderHook(
      () =>
        useQuery<InSchema, 'patient_sessions'>('patient_sessions', [
          Q.on('patient_session_nurses', 'nurse_id', 'n1'),
        ]),
      { wrapper: wrapper(db) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([]);
    await act(() => db.write(tx => tx.insert('patient_session_nurses', { session_id: 's1', nurse_id: 'n1' })));
    await waitFor(() => expect(result.current.data.map(r => r.id)).toEqual(['s1']));
  });

  it('useRecord and useCount follow changes', async () => {
    const { db } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('nurses', { id: 'n1', name: 'A' }));
    const { result } = renderHook(
      () => ({
        rec: useRecord<InSchema, 'nurses'>('nurses', 'n1'),
        count: useCount<InSchema, 'nurses'>('nurses'),
      }),
      { wrapper: wrapper(db) },
    );
    await waitFor(() => expect(result.current.rec.data?.name).toBe('A'));
    expect(result.current.count.data).toBe(1);
    await act(() =>
      db.write(async tx => {
        await tx.update('nurses', 'n1', { name: 'B' });
        await tx.insert('nurses', { id: 'n2' });
      }),
    );
    await waitFor(() => expect(result.current.rec.data?.name).toBe('B'));
    await waitFor(() => expect(result.current.count.data).toBe(2));
  });

  it('useTableChanges only fires for watched tables', async () => {
    const { db } = await openTestDb(inSchema);
    const cb = vi.fn();
    renderHook(() => useTableChanges(['nurses'], cb), { wrapper: wrapper(db) });
    await act(() => db.write(tx => tx.insert('patient_sessions', {})));
    expect(cb).not.toHaveBeenCalled();
    await act(() => db.write(tx => tx.insert('nurses', {})));
    expect(cb).toHaveBeenCalledOnce();
  });

  it('surfaces query errors', async () => {
    const { db } = await openTestDb(inSchema);
    const { result } = renderHook(
      () => useQuery<InSchema, 'nurses'>('nurses', [Q.where('bogus', 1)]),
      { wrapper: wrapper(db) },
    );
    await waitFor(() => expect(result.current.error?.message).toMatch(/Unknown column/));
  });
});
