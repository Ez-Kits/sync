import type { CollectionConfig } from "./types";

type PrimaryKeyConfig = Pick<
  CollectionConfig<any, any, any, any, any, any>,
  "name" | "primaryField"
>;

/** The fields of a collection's primary key, in order. */
export function primaryFields(config: PrimaryKeyConfig): string[] {
  const { primaryField } = config;
  if (!Array.isArray(primaryField)) return [String(primaryField)];
  const fields = primaryField.map(String);
  if (fields.length === 0 || new Set(fields).size !== fields.length) {
    throw new TypeError(
      `Collection "${config.name}" needs distinct fields in its composite primary key, got ` +
        `${JSON.stringify(fields)}.`,
    );
  }
  return fields;
}

/** The primary key of a row: its primary field's value, or an object of every key field. */
export function primaryKeyOf(config: PrimaryKeyConfig, row: Record<string, unknown>): unknown {
  const fields = primaryFields(config);
  if (!Array.isArray(config.primaryField)) return row[fields[0]!];
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

/**
 * The `[field, value]` pairs a key matches a row by, for an adapter's `WHERE`. Rejects an
 * object for a single field and anything but an object for a composite key.
 */
export function primaryKeyEntries(config: PrimaryKeyConfig, key: unknown): [string, unknown][] {
  const fields = primaryFields(config);
  const isObject = typeof key === "object" && key !== null;
  if (!Array.isArray(config.primaryField)) {
    if (!isObject) return [[fields[0]!, key]];
    throw new TypeError(
      `Collection "${config.name}" has a single primary field "${fields[0]}": pass its value, ` +
        "not an object.",
    );
  }
  if (!isObject) throw compositeKeyError(config, fields, key);
  return fields.map((field) => [field, (key as Record<string, unknown>)[field]]);
}

/**
 * The string the outbox identifies a record by: the key itself for one field,
 * or a JSON array of the key values, in `primaryField` order, for a composite key.
 */
export function recordIdOf(config: PrimaryKeyConfig, key: unknown): string {
  const fields = primaryFields(config);
  if (!Array.isArray(config.primaryField)) return String(keyValue(config, fields[0]!, key));
  if (typeof key !== "object" || key === null) throw compositeKeyError(config, fields, key);
  const values = fields.map((field) =>
    keyValue(config, field, (key as Record<string, unknown>)[field]),
  );
  return JSON.stringify(values);
}

function keyValue(config: PrimaryKeyConfig, field: string, value: unknown): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  throw new TypeError(
    `Collection "${config.name}" needs a string or number value in its primary field ` +
      `"${field}", got ${describe(value)}.`,
  );
}

function compositeKeyError(config: PrimaryKeyConfig, fields: string[], key: unknown): TypeError {
  return new TypeError(
    `Collection "${config.name}" has a composite primary key ${JSON.stringify(fields)}: ` +
      `pass an object of its fields, got ${describe(key)}.`,
  );
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value;
}
