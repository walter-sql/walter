import { SqlEvalError } from "./ir";

export interface Dec {
  readonly digits: bigint;
  readonly scale: number;
}

export const NUMERIC_DSCALE_MAX = 16383;
const NUMERIC_MAX_INT_DIGITS = 131072;

export function clampRoundScale(scale: number): number {
  if (!Number.isFinite(scale)) return 0;
  const s = Math.trunc(scale);
  return s > NUMERIC_DSCALE_MAX ? NUMERIC_DSCALE_MAX : s;
}

const DEC_RE = /^-?\d+(\.\d+)?$/;

const DEC_LIT_RE =
  /^([+-]?)(?:(\d(?:_?\d)*)(?:\.(\d(?:_?\d)*)?)?|\.(\d(?:_?\d)*))(?:[eE]([+-]?\d(?:_?\d)*))?$/;
const RADIX_LIT_RE =
  /^([+-]?)(0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*)$/;

export function canonDec(text: string): Dec | null {
  const t = text.trim();
  const r = RADIX_LIT_RE.exec(t);
  if (r) {
    let digits = BigInt(r[2]!.replace(/_/g, ""));
    if (r[1] === "-") digits = -digits;
    if (intDigitsOf(digits, 0) > NUMERIC_MAX_INT_DIGITS) return null;
    return { digits, scale: 0 };
  }
  const m = DEC_LIT_RE.exec(t);
  if (!m) return null;
  const int = (m[2] ?? "").replace(/_/g, "");
  const frac = (m[3] ?? m[4] ?? "").replace(/_/g, "");
  const exp = m[5] ? Number(m[5].replace(/_/g, "")) : 0;
  let digits = BigInt(int + frac);
  if (m[1] === "-") digits = -digits;
  const scale = frac.length - exp;
  if (!Number.isFinite(scale)) return null;
  if (scale < 0) {
    if (intDigitsOf(digits, 0) - scale > NUMERIC_MAX_INT_DIGITS) return null;
    return { digits: digits * pow10(-scale), scale: 0 };
  }
  if (scale > NUMERIC_DSCALE_MAX) return null;
  if (intDigitsOf(digits, scale) > NUMERIC_MAX_INT_DIGITS) return null;
  return { digits, scale };
}

export function canonNumeric(text: string): string | null {
  const d = canonDec(text);
  return d === null ? null : renderDec(d);
}

function intDigitsOf(digits: bigint, scale: number): number {
  const abs = digits < 0n ? -digits : digits;
  return Math.max(abs.toString().length - scale, 0);
}

export function parseDec(text: string): Dec | null {
  if (!DEC_RE.test(text)) return null;
  const dot = text.indexOf(".");
  if (dot < 0) return { digits: BigInt(text), scale: 0 };
  return {
    digits: BigInt(text.slice(0, dot) + text.slice(dot + 1)),
    scale: text.length - dot - 1
  };
}

export function decFrom(v: unknown): Dec | null {
  if (typeof v === "string") return parseDec(v) ?? canonDec(v);
  if (typeof v === "bigint") return { digits: v, scale: 0 };
  if (typeof v === "number" && Number.isFinite(v)) {
    if (Number.isSafeInteger(v)) return { digits: BigInt(v), scale: 0 };
    const s = String(v);
    return parseDec(s) ?? canonDec(s);
  }
  return null;
}

const F64 = new DataView(new ArrayBuffer(8));

export function decExact(v: number): Dec {
  F64.setFloat64(0, v);
  const bits = F64.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let m = (bits & 0xfffffffffffffn) | (expBits === 0 ? 0n : 0x10000000000000n);
  if (m === 0n) return { digits: 0n, scale: 0 };
  let e = (expBits === 0 ? 1 : expBits) - 1075;
  for (; (m & 1n) === 0n; e++) m >>= 1n;
  if (bits >> 63n) m = -m;
  return e >= 0
    ? { digits: m << BigInt(e), scale: 0 }
    : { digits: m * 5n ** BigInt(-e), scale: -e };
}

export function renderDec(d: Dec): string {
  const neg = d.digits < 0n;
  let s = (neg ? -d.digits : d.digits).toString();
  if (d.scale > 0) {
    if (s.length <= d.scale) s = "0".repeat(d.scale - s.length + 1) + s;
    const cut = s.length - d.scale;
    s = `${s.slice(0, cut)}.${s.slice(cut)}`;
  }
  return neg ? `-${s}` : s;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function rescale(d: Dec, scale: number): bigint {
  return scale === d.scale ? d.digits : d.digits * pow10(scale - d.scale);
}

export function addDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { digits: rescale(a, scale) + rescale(b, scale), scale };
}

export function subDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { digits: rescale(a, scale) - rescale(b, scale), scale };
}

export function mulDec(a: Dec, b: Dec): Dec {
  return { digits: a.digits * b.digits, scale: a.scale + b.scale };
}

export function negDec(d: Dec): Dec {
  return { digits: -d.digits, scale: d.scale };
}

export function absDec(d: Dec): Dec {
  return d.digits < 0n ? negDec(d) : d;
}

export function trimDec(d: Dec): Dec {
  let { digits, scale } = d;
  while (scale > 0 && digits % 10n === 0n) {
    digits /= 10n;
    scale--;
  }
  return { digits, scale };
}

export function cmpDec(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function roundDec(d: Dec, scale: number): Dec {
  if (scale >= d.scale) return { digits: rescale(d, scale), scale };
  const abs = d.digits < 0n ? -d.digits : d.digits;
  if (scale < 0 && -scale > abs.toString().length - d.scale)
    return { digits: 0n, scale: 0 };
  const f = pow10(d.scale - scale);
  let q = d.digits / f;
  const r = d.digits % f;
  const absR = r < 0n ? -r : r;
  if (2n * absR >= f) q += d.digits < 0n ? -1n : 1n;
  if (scale < 0) {
    if (q === 0n) return { digits: 0n, scale: 0 };
    const qDigits = (q < 0n ? -q : q).toString().length;
    if (qDigits - scale > NUMERIC_MAX_INT_DIGITS)
      throw new SqlEvalError("value overflows numeric format");
    return { digits: q * pow10(-scale), scale: 0 };
  }
  return { digits: q, scale };
}

export class DecSum {
  private digits = 0n;
  private cap = 0;
  private weight = 0;
  private readonly scaleCounts = new Map<number, number>();

  add(d: Dec, w: number): void {
    this.weight += w;
    const c = (this.scaleCounts.get(d.scale) ?? 0) + w;
    if (c === 0) this.scaleCounts.delete(d.scale);
    else this.scaleCounts.set(d.scale, c);
    if (d.scale > this.cap) {
      this.digits *= pow10(d.scale - this.cap);
      this.cap = d.scale;
    }
    this.digits += rescale(d, this.cap) * BigInt(w);
  }

  get nonNullWeight(): number {
    return this.weight;
  }

  value(): string | null {
    if (this.weight <= 0) return null;
    let scale = 0;
    for (const s of this.scaleCounts.keys()) if (s > scale) scale = s;
    const digits =
      scale === this.cap ? this.digits : this.digits / pow10(this.cap - scale);
    return renderDec({ digits, scale });
  }
}
