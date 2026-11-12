export type ColumnType = 'string' | 'number' | 'boolean';

export interface ColumnSchema {
  readonly name: string;
  readonly type: ColumnType;
  readonly isOptional: boolean;
  readonly isIndexed: boolean;
}

export class ColumnBuilder<T extends ColumnType = ColumnType, O extends boolean = boolean> {
  /** Type-level marker only. */
  declare readonly __optional: O;

  constructor(
    readonly type: T,
    readonly isOptional: O,
    readonly isIndexed: boolean = false,
  ) {}

  optional(): ColumnBuilder<T, true> {
    return new ColumnBuilder(this.type, true, this.isIndexed);
  }

  indexed(): ColumnBuilder<T, O> {
    return new ColumnBuilder(this.type, this.isOptional, true);
  }
}

export const col = {
  string: () => new ColumnBuilder('string', false),
  number: () => new ColumnBuilder('number', false),
  boolean: () => new ColumnBuilder('boolean', false),
};

type BaseValue<T extends ColumnType> = T extends 'string'
  ? string
  : T extends 'number'
    ? number
    : boolean;

export type ColumnValue<B> =
  B extends ColumnBuilder<infer T, infer O> ? (O extends true ? BaseValue<T> | null : BaseValue<T>) : never;

export type ColumnBuilders = Record<string, ColumnBuilder<ColumnType, boolean>>;
