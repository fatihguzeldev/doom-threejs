export type Parser<T> = (value: unknown, path: string) => T;

export function invalid(path: string, expected: string): never {
  throw new Error(`Invalid save ${path}: expected ${expected}`);
}

export function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'object');
  return value as Record<string, unknown>;
}

export function shape<T>(schema: { readonly [K in keyof T]: Parser<T[K]> }): Parser<T> {
  return (value, path) => {
    const source = object(value, path);
    for (const key of Object.keys(source)) if (!Object.hasOwn(schema, key)) invalid(`${path}.${key}`, 'known field');
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(schema) as (keyof T & string)[]) {
      result[key] = schema[key](source[key], `${path}.${key}`);
    }
    // Every property was independently parsed against the complete typed schema.
    return result as T;
  };
}

export const boolean: Parser<boolean> = (value, path) => typeof value === 'boolean' ? value : invalid(path, 'boolean');

export function integer(minimum = -0x80000000, maximum = 0x7fffffff): Parser<number> {
  return (value, path) => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid(path, `integer ${minimum}..${maximum}`);
}

export function string(maximum = 4096): Parser<string> {
  return (value, path) => typeof value === 'string' && value.length <= maximum ? value : invalid(path, `string of at most ${maximum} characters`);
}

export function oneOf<T extends string | number>(values: readonly T[]): Parser<T> {
  return (value, path) => {
    const found = values.find(candidate => candidate === value);
    return found === undefined ? invalid(path, values.join('|')) : found;
  };
}

export function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value, path) => value === null ? null : parse(value, path);
}

export function array<T>(parse: Parser<T>, length?: number, maximum = 100000): Parser<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) invalid(path, 'array');
    const values: readonly unknown[] = value;
    if ((length !== undefined && values.length !== length) || values.length > maximum) invalid(path, length === undefined ? `at most ${maximum} entries` : `${length} entries`);
    return values.map((entry, index) => parse(entry, `${path}[${index}]`));
  };
}

export const int32 = integer();
export const uint32 = integer(0, 0xffffffff);
export const nonnegative = integer(0, Number.MAX_SAFE_INTEGER);
