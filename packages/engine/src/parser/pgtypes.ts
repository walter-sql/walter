import pg from "pg";
import { UnsupportedSqlError, type PgClass } from "./ir";
import { canonDec, canonNumeric } from "./decimal";

// Time/bytea stay in PG text form; non-finite floats keep PG's text; sessions pin TimeZone=UTC.
const NONFINITE = new Set(["NaN", "Infinity", "-Infinity"]);
const TEXT = (v: string) => v;
const TEXT_ARRAY = pg.types.getTypeParser(1009 as number);
const PARSERS = new Map<number, (v: string) => unknown>([
  [17, TEXT],
  [1082, TEXT],
  [1114, TEXT],
  [1184, TEXT],
  [700, v => (NONFINITE.has(v) ? v : Math.fround(parseFloat(v)))],
  [701, v => (NONFINITE.has(v) ? v : parseFloat(v))],
  [1001, TEXT_ARRAY],
  [1182, TEXT_ARRAY],
  [1115, TEXT_ARRAY],
  [1185, TEXT_ARRAY]
]);

export const walterTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    format === "binary"
      ? pg.types.getTypeParser(oid, format)
      : (PARSERS.get(oid) ??
        pg.types.getTypeParser(oid))) as typeof pg.types.getTypeParser
};

export function parseNonFinite(
  s: string
): "NaN" | "Infinity" | "-Infinity" | undefined {
  const t = s.trim().toLowerCase();
  if (t === "nan") return "NaN";
  const sign = t[0] === "-" ? "-" : "";
  const body = t[0] === "+" || t[0] === "-" ? t.slice(1) : t;
  if (body === "inf" || body === "infinity")
    return sign === "-" ? "-Infinity" : "Infinity";
  return undefined;
}

export function nonFiniteText(n: number): "NaN" | "Infinity" | "-Infinity" {
  return Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity";
}

export function classCanon(cls: PgClass, text: string): string | null {
  if (cls === "int2" || cls === "int" || cls === "int8") {
    const t = text.trim();
    if (!/^[+-]?\d+$/.test(t)) return null;
    const n = BigInt(t);
    const [min, max] = INT_BOUNDS[cls];
    return n < min || n > max ? null : n.toString();
  }
  if (cls !== "float4" && cls !== "float" && cls !== "numeric") return null;
  const nf = parseNonFinite(text);
  if (nf) return nf;
  const canon = canonNumeric(text);
  if (canon === null || cls === "numeric") return canon;
  const n = Number(canon);
  if (!Number.isFinite(n)) return null;
  if (cls === "float4" && !Number.isFinite(Math.fround(n))) return null;
  return canon;
}

const INT_BOUNDS = {
  int2: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  int8: [-(2n ** 63n), 2n ** 63n - 1n]
} as const;

export function classValue(cls: PgClass, canon: string): string | number {
  if (parseNonFinite(canon) !== undefined) return canon;
  if (cls === "float") return Number(canon);
  if (cls === "float4") return Math.fround(Number(canon));
  if (cls === "int2" || cls === "int") return Number(canon);
  return canon;
}

export function inputValue(cls: PgClass, v: unknown): unknown {
  if (v === null) return null;
  const name = PG_CLASS_NAME[cls];
  const shown = JSON.stringify(v);
  switch (SORT_OF[cls]) {
    case "number": {
      if (
        typeof v !== "string" &&
        typeof v !== "number" &&
        typeof v !== "bigint"
      )
        throw new UnsupportedSqlError(`${shown} is not valid for type ${name}`);
      if (cls === "int8" && typeof v === "number" && !Number.isSafeInteger(v))
        throw new UnsupportedSqlError(
          `${shown} is not exact as ${name}; pass it as text`
        );
      const text = String(v);
      const canon = classCanon(cls, text);
      if (canon === null)
        throw new UnsupportedSqlError(numberInputError(cls, text));
      return classValue(cls, canon);
    }
    case "bool": {
      if (typeof v === "boolean") return v;
      const b =
        typeof v === "string"
          ? parseBoolText(v)
          : v === 1
            ? true
            : v === 0
              ? false
              : undefined;
      if (b === undefined)
        throw new UnsupportedSqlError(
          `invalid input syntax for type boolean: ${shown}`
        );
      return b;
    }
    case "time": {
      const t = typeof v === "string" ? normalizeTimeText(v, cls) : undefined;
      if (t === undefined)
        throw new UnsupportedSqlError(
          `invalid input syntax for type ${name}: ${shown} (Walter takes ISO 8601 only)`
        );
      return t;
    }
    case "bytes": {
      const t =
        typeof v !== "string"
          ? undefined
          : cls === "uuid"
            ? normalizeUuidText(v)
            : normalizeByteaText(v);
      if (t === undefined)
        throw new UnsupportedSqlError(
          `invalid input syntax for type ${name}: ${shown}` +
            (cls === "bytea" ? " (hex form only: \\xdeadbeef)" : "")
        );
      return t;
    }
    case "text":
      return typeof v === "string" ? v : String(v);
  }
}

function numberInputError(cls: PgClass, text: string): string {
  const name = PG_CLASS_NAME[cls];
  const syntax = `invalid input syntax for type ${name}: "${text}"`;
  if (cls === "int2" || cls === "int" || cls === "int8") {
    return /^[+-]?\d+$/.test(text.trim())
      ? `value "${text}" is out of range for type ${name}`
      : syntax;
  }
  if (cls === "numeric") return syntax;
  return canonDec(text) === null
    ? syntax
    : `"${text}" is out of range for type ${name}`;
}

export const TIME_ZONED =
  /([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)(Z|[+-]\d{2}(:\d{2})?)$/;

export type SortClass = "number" | "text" | "bytes" | "bool" | "time";

export type CastTarget =
  | "int2"
  | "int"
  | "int8"
  | "float"
  | "numeric"
  | "text"
  | "bool"
  | "uuid"
  | "date"
  | "timestamp"
  | "timestamptz";

interface PgTypeInfo {
  cls?: PgClass;
  sort?: SortClass;
  cast?: CastTarget;
}

const PG_TYPES: Record<string, PgTypeInfo> = {
  int2: { cls: "int2", sort: "number", cast: "int2" },
  int4: { cls: "int", sort: "number", cast: "int" },
  int8: { cls: "int8", sort: "number", cast: "int8" },
  smallint: { cast: "int2" },
  integer: { cast: "int" },
  bigint: { cast: "int8" },
  oid: { cls: "int", sort: "number" },
  // float4 has no cast target: narrowing is not reproduced (use ::float8).
  float4: { cls: "float4", sort: "number" },
  float8: { cls: "float", sort: "number", cast: "float" },
  double: { cast: "float" },
  numeric: { cls: "numeric", sort: "number", cast: "numeric" },
  decimal: { cast: "numeric" },
  text: { cls: "text", sort: "text", cast: "text" },
  varchar: { cls: "text", sort: "text", cast: "text" },
  bpchar: { cls: "text", sort: "text", cast: "text" },
  // `char` is the internal 1-byte type (::"char" truncates); no cast target.
  char: { cls: "text", sort: "text" },
  name: { cls: "text", sort: "text" },
  uuid: { cls: "uuid", sort: "bytes", cast: "uuid" },
  bytea: { cls: "bytea", sort: "bytes" },
  bool: { cls: "bool", sort: "bool", cast: "bool" },
  boolean: { cast: "bool" },
  timestamp: { cls: "timestamp", sort: "time", cast: "timestamp" },
  timestamptz: { cls: "timestamptz", sort: "time", cast: "timestamptz" },
  date: { cls: "date", sort: "time", cast: "date" }
};

export function pgClassOf(typname: string | undefined): PgClass | undefined {
  return typname === undefined ? undefined : PG_TYPES[typname]?.cls;
}

export const PG_CLASS_NAME: Record<PgClass, string> = {
  int2: "smallint",
  int: "integer",
  int8: "bigint",
  float4: "real",
  float: "double precision",
  numeric: "numeric",
  text: "text",
  bool: "boolean",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  uuid: "uuid",
  bytea: "bytea"
};

export const SORT_OF: Record<PgClass, SortClass> = {
  int2: "number",
  int: "number",
  int8: "number",
  float4: "number",
  float: "number",
  numeric: "number",
  text: "text",
  bool: "bool",
  date: "time",
  timestamp: "time",
  timestamptz: "time",
  uuid: "bytes",
  bytea: "bytes"
};

export function sortClassOf(
  typname: string | undefined
): SortClass | undefined {
  return typname === undefined ? undefined : PG_TYPES[typname]?.sort;
}

export function castTargetOf(name: string): CastTarget | undefined {
  return PG_TYPES[name]?.cast;
}

export const CAST_SQL: Record<CastTarget, string> = {
  int2: "smallint",
  int: "integer",
  int8: "bigint",
  float: "double precision",
  numeric: "numeric",
  text: "text",
  bool: "boolean",
  uuid: "uuid",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamptz"
};

export const TIME_TEXT =
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:\d{2})?)?)?$/;

export function normalizeTimeText(
  s: string,
  cls: PgClass | undefined
): string | undefined {
  if (!TIME_TEXT.test(s)) return undefined;
  switch (cls) {
    case "date":
      return s.slice(0, 10);
    case "timestamp":
      return s.replace(TIME_ZONED, "$1");
    case "timestamptz":
      if (TIME_ZONED.test(s)) return s;
      return s.length === 10 ? `${s}T00:00:00Z` : `${s}Z`;
    default:
      return undefined;
  }
}

const UUID_BODY = /^[0-9a-fA-F]{4}(?:-?[0-9a-fA-F]{4}){7}$/;

export function normalizeUuidText(s: string): string | undefined {
  const braced = s.startsWith("{");
  if (braced !== s.endsWith("}")) return undefined;
  const body = braced ? s.slice(1, -1) : s;
  if (!UUID_BODY.test(body)) return undefined;
  const hex = body.replace(/-/g, "").toLowerCase();
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

export function parseBoolText(s: string): boolean | undefined {
  const t = s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "").toLowerCase();
  if (t.length === 0) return undefined;
  if ("true".startsWith(t) || "yes".startsWith(t) || t === "on" || t === "1")
    return true;
  if (
    "false".startsWith(t) ||
    "no".startsWith(t) ||
    t === "off" ||
    t === "of" ||
    t === "0"
  )
    return false;
  return undefined;
}

const BYTEA_HEX = /^(?:[ \t\n\r]*[0-9a-fA-F]{2})*[ \t\n\r]*$/;

export function normalizeByteaText(s: string): string | undefined {
  if (!s.startsWith("\\x")) return undefined;
  const digits = s.slice(2);
  if (!BYTEA_HEX.test(digits)) return undefined;
  return `\\x${digits.replace(/[ \t\n\r]+/g, "").toLowerCase()}`;
}
