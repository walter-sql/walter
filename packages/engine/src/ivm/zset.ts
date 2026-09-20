export type Scalar = string | number | boolean | null | bigint;
export type Row = Record<string, unknown>;

export interface ZSetEntry {
  readonly row: Row;
  weight: number;
}

export type ZSet = Map<string, ZSetEntry>;

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "0";
  switch (typeof value) {
    case "number":
    case "bigint":
      return `n${value}`;
    case "boolean":
      return value ? "T" : "F";
    case "string":
      return `s${value.length}:${value}`;
    case "object": {
      if (value instanceof Date) return `d${value.toISOString()}`;
      if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join("\u0001")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map(k => `${k.length}:${k}\u0002${stableStringify(obj[k])}`)
        .join("\u0001")}}`;
    }
    default:
      return `s${String(value).length}:${String(value)}`;
  }
}

export function rowKey(row: Row): string {
  return stableStringify(row);
}

export function keyOf(value: unknown, keyFields?: readonly string[]): string {
  if (keyFields && keyFields.length > 0 && isPlainObject(value)) {
    if (keyFields.length === 1) return stableStringify(value[keyFields[0]!]);
    const picked: Row = {};
    for (const f of keyFields) picked[f] = value[f];
    return stableStringify(picked);
  }
  return stableStringify(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function canonicalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v))
    return `\\x${v.toString("hex")}`;
  if (Array.isArray(v)) return v.map(canonicalize);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object))
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function emptyZSet(): ZSet {
  return new Map();
}

export function zsetAddRow(z: ZSet, row: Row, weight: number): void {
  if (weight === 0) return;
  zsetAddWithKey(z, rowKey(row), row, weight);
}

function zsetAddWithKey(z: ZSet, k: string, row: Row, weight: number): void {
  const existing = z.get(k);
  if (existing === undefined) {
    z.set(k, { row, weight });
    return;
  }
  existing.weight += weight;
  if (existing.weight === 0) z.delete(k);
}

export function zsetMergeInto(target: ZSet, delta: ZSet): ZSet {
  for (const [k, e] of delta) zsetAddWithKey(target, k, e.row, e.weight);
  return target;
}

export function zsetFromRows(rows: Iterable<Row>, weight = 1): ZSet {
  const z = emptyZSet();
  for (const row of rows) zsetAddRow(z, row, weight);
  return z;
}
