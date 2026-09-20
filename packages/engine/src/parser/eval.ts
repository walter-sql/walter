import type { ArithOp, Expr, PgClass, ScalarFunc } from "./ir";
import { SqlEvalError, UnsupportedSqlError } from "./ir";
import {
  nonFiniteText,
  normalizeTimeText,
  normalizeUuidText,
  parseBoolText,
  parseNonFinite,
  PG_CLASS_NAME,
  type SortClass
} from "./pgtypes";
import {
  absDec,
  addDec,
  canonNumeric,
  clampRoundScale,
  cmpDec,
  decFrom,
  mulDec,
  negDec,
  renderDec,
  roundDec,
  subDec,
  trimDec,
  type Dec
} from "./decimal";
import { stableStringify } from "../ivm/zset";

export type Params = readonly unknown[];

const INT_MIN = { int2: -32768, int: -2147483648 } as const;
const INT_MAX = { int2: 32767, int: 2147483647 } as const;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

function checkIntRange(cls: "int2" | "int", n: number): number {
  if (n < INT_MIN[cls] || n > INT_MAX[cls])
    throw new SqlEvalError(`${PG_CLASS_NAME[cls]} out of range`);
  return n;
}

function renderInt8(d: Dec): string {
  if (d.digits < INT8_MIN || d.digits > INT8_MAX)
    throw new SqlEvalError("bigint out of range");
  return renderDec(d);
}

function invalidInput(cls: PgClass, v: unknown): SqlEvalError {
  return new SqlEvalError(
    `invalid input syntax for type ${PG_CLASS_NAME[cls]}: "${String(v)}"`
  );
}

export function applyNeg(ptype: Expr["ptype"], v: unknown): unknown {
  if (isNull(v)) return null;
  if (ptype === "numeric" || ptype === "int8") {
    const d = decFrom(v);
    if (d)
      return ptype === "int8" ? renderInt8(negDec(d)) : renderDec(negDec(d));
    if (ptype === "numeric" && typeof v === "string") {
      const nf = parseNonFinite(v);
      if (nf)
        return nf === "NaN" ? nf : nf === "Infinity" ? "-Infinity" : "Infinity";
    }
    throw invalidInput(ptype, v);
  }
  const n = toNumber(v);
  if (n === null) throw invalidInput(ptype!, v);
  if (ptype === "int" || ptype === "int2") return checkIntRange(ptype, -n);
  const r = -n;
  return Number.isFinite(r) ? r : nonFiniteText(r);
}

export function applyBinary(
  op: ArithOp,
  ptype: Expr["ptype"],
  l: unknown,
  r: unknown
): unknown {
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      if (isNull(l) || isNull(r)) return null;
      if (ptype === "numeric" && (op === "+" || op === "-" || op === "*")) {
        const ld = decFrom(l);
        const rd = decFrom(r);
        if (ld && rd) {
          const d =
            op === "+"
              ? addDec(ld, rd)
              : op === "-"
                ? subDec(ld, rd)
                : mulDec(ld, rd);
          return renderDec(d);
        }
      }
      if (ptype === "int8") {
        const ld = decFrom(l);
        const rd = decFrom(r);
        if (!ld || !rd) throw invalidInput(ptype, ld ? r : l);
        switch (op) {
          case "+":
            return renderInt8(addDec(ld, rd));
          case "-":
            return renderInt8(subDec(ld, rd));
          case "*":
            return renderInt8(mulDec(ld, rd));
          case "/":
            if (rd.digits === 0n) throw new SqlEvalError("division by zero");
            return renderInt8({ digits: ld.digits / rd.digits, scale: 0 });
          case "%":
            if (rd.digits === 0n) throw new SqlEvalError("division by zero");
            return renderInt8({ digits: ld.digits % rd.digits, scale: 0 });
        }
      }
      const ln = toNumber(l);
      const rn = toNumber(r);
      if (ln === null || rn === null)
        throw invalidInput(ptype!, ln === null ? l : r);
      if ((op === "/" || op === "%") && rn === 0)
        throw new SqlEvalError("division by zero");
      let raw: number;
      switch (op) {
        case "+":
          raw = ln + rn;
          break;
        case "-":
          raw = ln - rn;
          break;
        case "*":
          raw = ln * rn;
          break;
        case "/":
          raw =
            ptype === "int" || ptype === "int2" ? Math.trunc(ln / rn) : ln / rn;
          break;
        case "%":
          raw = ln % rn;
          break;
      }
      if (ptype === "int" || ptype === "int2") return checkIntRange(ptype, raw);
      const res = ptype === "float4" ? Math.fround(raw) : raw;
      if (!Number.isFinite(res)) {
        if (Number.isFinite(ln) && Number.isFinite(rn))
          throw new SqlEvalError("value out of range: overflow");
        return nonFiniteText(res);
      }
      if (
        res === 0 &&
        ((op === "*" && ln !== 0 && rn !== 0) ||
          (op === "/" && ln !== 0 && Number.isFinite(rn)))
      ) {
        throw new SqlEvalError("value out of range: underflow");
      }
      return res;
    }
    default: {
      const _exhaustive: never = op;
      throw new UnsupportedSqlError(`unknown operator ${String(_exhaustive)}`);
    }
  }
}

export function applyCast(
  to: Extract<Expr, { kind: "cast" }>["to"],
  operandPtype: Expr["ptype"],
  v: unknown
): unknown {
  if (isNull(v)) return null;
  switch (to) {
    case "int2":
    case "int":
    case "int8":
      return castToInt(to, operandPtype, v);
    case "float": {
      if (typeof v === "string" && parseNonFinite(v)) return parseNonFinite(v);
      const n = toNumber(v);
      if (n === null) throw invalidInput("float", v);
      if (!Number.isFinite(n))
        throw new SqlEvalError(
          `"${String(v)}" is out of range for type double precision`
        );
      return n;
    }
    case "numeric": {
      if (typeof v === "string" && parseNonFinite(v)) return parseNonFinite(v);
      // PG's float->numeric is %.15g / %.6g of the value, not shortest text.
      if (operandPtype === "float" || operandPtype === "float4") {
        const n = toNumber(v);
        if (n === null) return null;
        if (!Number.isFinite(n)) return nonFiniteText(n);
        return floatToNumericText(n, operandPtype === "float" ? 15 : 6);
      }
      const d = decFrom(v);
      if (d) return renderDec(d);
      if (typeof v === "number") return nonFiniteText(v);
      if (typeof v === "string") throw invalidInput("numeric", v);
      return toNumber(v);
    }
    case "bool":
      if (typeof v === "boolean") return v;
      if (typeof v === "string") {
        const b = parseBoolText(v);
        if (b === undefined)
          throw new SqlEvalError(
            `invalid input syntax for type boolean: "${v}"`
          );
        return b;
      }
      return toNumber(v) !== 0;
    case "uuid":
      if (typeof v !== "string") return null;
      return (
        normalizeUuidText(v) ??
        (() => {
          throw new SqlEvalError(`invalid input syntax for type uuid: "${v}"`);
        })()
      );
    case "date":
    case "timestamp":
    case "timestamptz": {
      if (typeof v !== "string") return null;
      const t = normalizeTimeText(v, to);
      if (t === undefined)
        throw new SqlEvalError(`invalid input syntax for type ${to}: "${v}"`);
      return t;
    }
    case "text":
      return String(v);
    default: {
      const _exhaustive: never = to;
      throw new UnsupportedSqlError(`unknown cast ${String(_exhaustive)}`);
    }
  }
}

function floatToNumericText(n: number, digits: number): string {
  const g = n
    .toPrecision(digits)
    .replace(/(\.\d*?)0+(?=e|$)/, "$1")
    .replace(/\.(?=e|$)/, "");
  return canonNumeric(g)!;
}

function castToInt(
  to: "int2" | "int" | "int8",
  from: Expr["ptype"],
  v: unknown
): unknown {
  if (typeof v === "string") {
    const nf = parseNonFinite(v);
    if (nf) {
      if (from === "numeric")
        throw new SqlEvalError(
          `cannot convert ${nf === "NaN" ? "NaN" : "infinity"} to ${PG_CLASS_NAME[to]}`
        );
      throw new SqlEvalError(`${PG_CLASS_NAME[to]} out of range`);
    }
  }
  if (from === "float" || from === "float4") {
    const n = toNumber(v);
    if (n === null) return null;
    if (!Number.isFinite(n))
      throw new SqlEvalError(`${PG_CLASS_NAME[to]} out of range`);
    const r = roundHalfEven(n);
    if (to === "int8") return renderInt8({ digits: BigInt(r), scale: 0 });
    return checkIntRange(to, r);
  }
  const d = decFrom(v);
  if (d) {
    const rounded = roundDec(d, 0);
    if (to === "int8") return renderInt8(rounded);
    return checkIntRange(to, Number(rounded.digits));
  }
  const n = toNumber(v);
  if (n === null) throw invalidInput(to, v);
  const r = roundHalfAwayFromZero(n);
  if (to === "int8")
    return renderInt8({ digits: BigInt(Math.trunc(r)), scale: 0 });
  return checkIntRange(to, r);
}

export function applyFunc(
  name: ScalarFunc,
  a: unknown[],
  argPtypes: Expr["ptype"][]
): unknown {
  switch (name) {
    case "lower":
      return isNull(a[0]) ? null : asciiLower(String(a[0]));
    case "upper":
      return isNull(a[0]) ? null : asciiUpper(String(a[0]));
    case "length":
    case "char_length":
      if (isNull(a[0])) return null;
      // bytea travels as PG hex text (`\x4f2a`).
      if (name === "length" && argPtypes[0] === "bytea")
        return (String(a[0]).length - 2) / 2;
      return [...String(a[0])].length;
    case "abs": {
      if (isNull(a[0])) return null;
      const cls = argPtypes[0];
      if (cls === "numeric" || cls === "int8") {
        const d = decFrom(a[0]);
        if (d)
          return cls === "int8" ? renderInt8(absDec(d)) : renderDec(absDec(d));
        if (typeof a[0] === "string") {
          const nf = parseNonFinite(a[0]);
          if (nf) return nf === "-Infinity" ? "Infinity" : nf;
        }
      }
      const n = toNumber(a[0]);
      if (n === null) return null;
      const r = Math.abs(n);
      if (cls === "int" || cls === "int2") return checkIntRange(cls, r);
      return Number.isFinite(r) ? r : nonFiniteText(r);
    }
    case "round": {
      if (isNull(a[0]) || (a.length > 1 && isNull(a[1]))) return null;
      // round(float8) is rint (half-even).
      if (argPtypes[0] === "float" || argPtypes[0] === "float4") {
        const n = toNumber(a[0]);
        if (n === null) return null;
        const r = roundHalfEven(n);
        return Number.isFinite(r) ? r : nonFiniteText(r);
      }
      // round(numeric[, n]) is half away from zero at scale n exactly.
      if (typeof a[0] === "string" && parseNonFinite(a[0]))
        return parseNonFinite(a[0]);
      const places = a.length > 1 ? clampRoundScale(toNumber(a[1]) ?? 0) : 0;
      const d = decFrom(a[0]);
      if (d) return renderDec(roundDec(d, places));
      const n = toNumber(a[0]);
      return n === null ? null : roundHalfEven(n);
    }
    case "concat":
      return a
        .map(v =>
          isNull(v) ? "" : typeof v === "boolean" ? (v ? "t" : "f") : String(v)
        )
        .join("");
  }
}

export function isNull(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

export function roundHalfEven(n: number): number {
  const f = Math.floor(n);
  if (n - f !== 0.5) return Math.round(n);
  return f % 2 === 0 ? f : f + 1;
}

export function roundHalfAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const nf = parseNonFinite(v);
    if (nf) return Number(nf);
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nonFiniteRank(v: unknown): number {
  if (typeof v === "string")
    return v === "NaN" ? 2 : v === "Infinity" ? 1 : v === "-Infinity" ? -1 : 0;
  if (typeof v === "number" && !Number.isFinite(v))
    return Number.isNaN(v) ? 2 : v > 0 ? 1 : -1;
  return 0;
}

export function compareFloatResolved(a: unknown, b: unknown): number {
  const ra = nonFiniteRank(a);
  const rb = nonFiniteRank(b);
  if (ra !== 0 || rb !== 0) return Math.sign(ra - rb);
  return Math.sign(floatLift(a) - floatLift(b));
}

function floatLift(v: unknown): number {
  const n = toNumber(v);
  if (n === null || !Number.isFinite(n)) {
    throw new SqlEvalError(
      `"${String(v)}" is out of range for type double precision`
    );
  }
  return n;
}

function compareScalar(a: unknown, b: unknown): number {
  if (typeof a === "boolean" || typeof b === "boolean") {
    const av = a ? 1 : 0;
    const bv = b ? 1 : 0;
    return Math.sign(av - bv);
  }
  const ra = nonFiniteRank(a);
  const rb = nonFiniteRank(b);
  if (ra !== 0 || rb !== 0) return Math.sign(ra - rb);
  if (typeof a === "string" || typeof b === "string") {
    const ad = decFrom(a);
    const bd = ad ? decFrom(b) : null;
    if (ad && bd) return cmpDec(ad, bd);
  }
  const an = numericIfPossible(a);
  const bn = numericIfPossible(b);
  if (an !== null && bn !== null) return Math.sign(an - bn);
  return compareTextBytewise(String(a), String(b));
}

// UTF-8 byte order (Postgres COLLATE "C"): code points, not UTF-16 units.
export function compareTextBytewise(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const ra = a.length - i;
  const rb = b.length - j;
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

function numericIfPossible(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  return null;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
}

function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 32));
}

const LIKE_ANY = -1;
const LIKE_ONE = -2;

export function likeMatcher(
  pattern: string,
  ci: boolean
): (value: string) => boolean {
  const p = ci ? asciiLower(pattern) : pattern;
  const tokens: number[] = [];
  for (let i = 0; i < p.length;) {
    let cp = p.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (cp === 92) {
      if (i === p.length)
        throw new UnsupportedSqlError(
          "LIKE pattern must not end with escape character"
        );
      cp = p.codePointAt(i)!;
      i += cp > 0xffff ? 2 : 1;
      tokens.push(cp);
    } else {
      tokens.push(cp === 37 ? LIKE_ANY : cp === 95 ? LIKE_ONE : cp);
    }
  }
  const match = (s: string): boolean => {
    let pi = 0;
    let si = 0;
    let starPi = -1;
    let starSi = 0;
    while (si < s.length) {
      const cp = s.codePointAt(si)!;
      if (
        pi < tokens.length &&
        (tokens[pi] === LIKE_ONE || tokens[pi] === cp)
      ) {
        pi++;
        si += cp > 0xffff ? 2 : 1;
      } else if (pi < tokens.length && tokens[pi] === LIKE_ANY) {
        starPi = pi++;
        starSi = si;
      } else if (starPi >= 0) {
        pi = starPi + 1;
        starSi += s.codePointAt(starSi)! > 0xffff ? 2 : 1;
        si = starSi;
      } else {
        return false;
      }
    }
    while (pi < tokens.length && tokens[pi] === LIKE_ANY) pi++;
    return pi === tokens.length;
  };
  return ci ? v => match(asciiLower(v)) : match;
}

export interface SortKeySpec {
  desc: boolean;
  nullsFirst: boolean;
  cls: SortClass;
}

export function compareClassValues(
  a: unknown,
  b: unknown,
  cls: SortClass
): number {
  switch (cls) {
    case "time": {
      const ta = timePoint(String(a));
      const tb = timePoint(String(b));
      if (ta !== null && tb !== null) {
        return ta.days !== tb.days
          ? Math.sign(ta.days - tb.days)
          : Math.sign(ta.micros - tb.micros);
      }
      return compareTextBytewise(String(a), String(b));
    }
    case "text":
    case "bytes":
      return compareTextBytewise(String(a), String(b));
    default:
      return compareScalar(a, b);
  }
}

export function identityOf(v: unknown, cls: SortClass | undefined): unknown {
  if (isNull(v)) return null;
  switch (cls) {
    case "number": {
      const d = decFrom(v);
      if (d) return renderDec(trimDec(d));
      return typeof v === "number" ? nonFiniteText(v) : v;
    }
    case "time": {
      const t = timePoint(String(v));
      return t ? `${t.days}:${t.micros}` : v;
    }
    default:
      return v;
  }
}

export function identityKey(
  values: readonly unknown[],
  classes: readonly (SortClass | undefined)[]
): string {
  if (values.length === 0) return "";
  return stableStringify(values.map((v, i) => identityOf(v, classes[i])));
}

export function compareSortKeys(
  a: readonly unknown[],
  b: readonly unknown[],
  keys: readonly SortKeySpec[]
): number {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const c = compareOrderKey(a[i], b[i], k.desc, k.nullsFirst, k.cls);
    if (c !== 0) return c;
  }
  return 0;
}

export function compareOrderKey(
  av: unknown,
  bv: unknown,
  desc: boolean,
  nullsFirst: boolean,
  cls: SortClass
): number {
  const aNull = isNull(av);
  const bNull = isNull(bv);
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    return aNull === nullsFirst ? -1 : 1;
  }
  const c = compareClassValues(av, bv, cls);
  return c === 0 ? 0 : desc ? -c : c;
}

const TIME_POINT =
  /^(\d{4,6})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::\d{2})?)?)?( BC)?$/;

function timePoint(v: string): { days: number; micros: number } | null {
  if (v === "infinity") return { days: Infinity, micros: 0 };
  if (v === "-infinity") return { days: -Infinity, micros: 0 };
  const m = TIME_POINT.exec(v);
  if (!m) return null;
  let year = Number(m[1]);
  if (m[9] !== undefined) year = 1 - year;
  const days = daysFromCivil(year, Number(m[2]), Number(m[3]));
  let micros =
    m[4] === undefined
      ? 0
      : Number(m[4]) * 3_600_000_000 +
        Number(m[5]) * 60_000_000 +
        Number(m[6] ?? 0) * 1_000_000 +
        fractionMicros(m[7]);
  const zone = m[8];
  if (zone !== undefined && zone !== "Z") {
    const hh = Number(zone.slice(1, 3));
    const mm = zone.length > 3 ? Number(zone.slice(4)) : 0;
    const offset = (zone[0] === "-" ? -1 : 1) * (hh * 60 + mm);
    micros -= offset * 60_000_000;
  }
  const carry = Math.floor(micros / 86_400_000_000);
  return { days: days + carry, micros: micros - carry * 86_400_000_000 };
}

function fractionMicros(digits: string | undefined): number {
  if (digits === undefined) return 0;
  let micros = Number(digits.slice(0, 6).padEnd(6, "0"));
  const rest = digits.slice(6).replace(/0+$/, "");
  if (rest !== "" && (rest > "5" || (rest === "5" && micros % 2 === 1)))
    micros += 1;
  return micros;
}

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.trunc((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
