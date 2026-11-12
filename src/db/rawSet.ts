import type { RawRecord } from '../schema/defineSchema';

export function addToRawSet(rawSet: string, value: string): string {
  const array = rawSet ? rawSet.split(',') : [];
  if (!array.includes(value)) array.push(value);
  return array.join(',');
}

/** Records a local column change, like WatermelonDB's `setRawColumnChange`. */
export function setRawColumnChange(raw: RawRecord, column: string): void {
  raw._changed = addToRawSet(raw._changed, column);
  if (raw._status !== 'created') raw._status = 'updated';
}
