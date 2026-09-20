import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { walterTypes } from "../src/parser/pgtypes";
import type { Expr } from "../src/parser/ir";
import { compileRowPredicate } from "../src/planner/compile";
import { exprToSql, PgRowSource } from "../src/lazy/pg-source";
import {
  corrValue,
  MemRowSource,
  type RowSource,
  type WindowPartition
} from "../src/lazy/rowsource";
import {
  windowTuple,
  type Reveal,
  type WindowSortKey
} from "../src/lazy/window";
import type { FromItem } from "../src/parser/ir";
import { threadExpr } from "../src/planner/types";
import { PlanScope } from "../src/planner/scope";
import { stableStringify, type Row } from "../src/ivm/zset";
import { SubscriptionManager } from "../src/subscriptions/manager";
import { SchemaCatalog } from "../src/parser/catalog";
import { initParser, parseSql } from "../src/parser/parse";
import { expandStars } from "../src/parser/expand";
import { foldArrayParams } from "../src/planner/plan";
import type { ViewSubscriber } from "../src/subscriptions/shape";
import { catalogOf, commit, IncrementalHarness, Rng } from "./support";
import type { RowOp } from "./support";
import { ownDatabase } from "./pg";

const CONN = ownDatabase("pg_equivalence");
if (process.env.CI && !CONN)
  throw new Error("CI must set WALTER_TEST_PG (pg-equivalence cannot skip)");

const col = (name: string): Expr => ({ kind: "column", table: "eqv", name });
const lit = (value: string | number | boolean | null): Expr => {
  if (value === null) return { kind: "literal", value };
  if (typeof value === "string")
    return { kind: "literal", value, ptype: "text", quoted: true };
  if (typeof value === "boolean")
    return { kind: "literal", value, ptype: "bool" };
  return {
    kind: "literal",
    value,
    ptype: Number.isInteger(value) ? "int" : "numeric"
  };
};
const PARAM: Expr = {
  kind: "cast",
  to: "int",
  operand: { kind: "param", index: 1 }
};

const INT_LITS = [-3, -1, 0, 1, 2, 3, 5, 6, 2147483647, -2147483647];
const NUM_LITS = [...INT_LITS, -0.5, 0.5, 1.5, 2.5, 0.1, 0.2, 0.3, 1.23];
const NONZERO_INT_LITS = [-3, -2, -1, 1, 2, 3];
const TEXT_LITS = [
  "a",
  "b",
  "c",
  "ab",
  "abc",
  "A",
  "B",
  "",
  "Ä",
  "é",
  "ζ",
  "😀",
  "zz",
  "a%",
  "a_c",
  "\\",
  "a\\b"
];
const PATTERNS = [
  "a%",
  "%b",
  "a_",
  "%",
  "_",
  "ab%",
  "%a%",
  "A%",
  "_b",
  "c",
  "%é%",
  "_😀%",
  "a\\%",
  "%\\%%",
  "a\\_c",
  "\\\\%",
  "\\A%"
];
const NUM_COLS = ["a", "b", "id", "n"];
const INT_COLS = ["a", "b", "id", "sm"];
const TS_LITS = [
  "2020-01-01T00:00:00Z",
  "2020-01-01T00:00:00.123Z",
  "2020-06-15T12:30:00Z",
  "1969-12-31T23:59:59Z",
  "2020-06-15T12:30:00Z"
];
const TS_ROW_LITS = [
  ...TS_LITS,
  "30000-01-01 00:00:00+00",
  "0100-06-01 12:00:00+00 BC"
];
const SM_LITS = [-32768, 32767, -3, 0, 1, 7];
const F8_LITS = [
  "NaN",
  "Infinity",
  "-Infinity",
  "1e300",
  "-1e300",
  "1e-300",
  "0.5",
  "1.5",
  "-2.25",
  "0.1"
];
const F4_LITS = [
  "NaN",
  "Infinity",
  "3e38",
  "-3e38",
  "0.5",
  "0.1",
  "3.14159265"
];
const NUM_NONFINITE = ["NaN", "Infinity", "-Infinity"];
const UUID_LITS = [
  "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  "0f000000-0000-0000-0000-000000000000",
  "10000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff"
];
const BYTEA_LITS = [
  Buffer.from("deadbeef", "hex"),
  Buffer.from("00", "hex"),
  Buffer.alloc(0),
  Buffer.from("0fff", "hex")
];
const BOOL_TEXT_LITS = [
  "t",
  "f",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "1",
  "0"
];

const EQV_TYPES = {
  eqv: {
    id: "int4",
    a: "int4",
    b: "int4",
    sm: "int2",
    f8: "float8",
    f4: "float4",
    s: "text",
    f: "bool",
    n: "numeric",
    ts: "timestamptz",
    u: "uuid",
    by: "bytea"
  }
};
const EQV_CATALOG = catalogOf({ columnTypes: EQV_TYPES });
const EQV_RESOLVER = new PlanScope([{ name: "eqv", alias: "eqv" }], EQV_CATALOG)
  .classOf;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[rng.int(arr.length)]!;
}

function intOperand(rng: Rng, depth: number): Expr {
  if (depth <= 0 || rng.int(3) === 0) {
    const r = rng.int(10);
    if (r < 5) return col(pick(rng, INT_COLS));
    if (r < 7) return PARAM;
    return lit(pick(rng, INT_LITS));
  }
  const r = rng.int(6);
  if (r === 0)
    return {
      kind: "binary",
      op: pick(rng, ["+", "-", "*"] as const),
      left: intOperand(rng, depth - 1),
      right: intOperand(rng, depth - 1)
    };
  if (r === 1)
    return { kind: "func", name: "abs", args: [intOperand(rng, depth - 1)] };
  if (r === 2)
    return {
      kind: "coalesce",
      args: [intOperand(rng, depth - 1), lit(pick(rng, INT_LITS))]
    };
  if (r === 3)
    return {
      kind: "binary",
      op: rng.int(2) === 0 ? "/" : "%",
      left: intOperand(rng, depth - 1),
      right: lit(rng.int(8) === 0 ? 0 : pick(rng, NONZERO_INT_LITS))
    };
  if (r === 4)
    return {
      kind: "cast",
      to: "int",
      operand: {
        kind: "coalesce",
        args: [col("n"), lit(pick(rng, NUM_LITS))]
      }
    };
  return col(pick(rng, INT_COLS));
}

function numArith(rng: Rng, depth: number): Expr {
  const operand = (d: number): Expr => {
    if (d <= 0 || rng.int(2) === 0) {
      return rng.int(2) === 0
        ? col(pick(rng, NUM_COLS))
        : lit(pick(rng, NUM_LITS));
    }
    return numArith(rng, d);
  };
  return {
    kind: "binary",
    op: pick(rng, ["+", "-", "*"] as const),
    left: operand(depth - 1),
    right: operand(depth - 1)
  };
}

function numOperand(rng: Rng, depth: number): Expr {
  if (depth <= 0 || rng.int(2) === 0) {
    const r = rng.int(12);
    if (r < 5) return col(pick(rng, NUM_COLS));
    if (r < 7) return PARAM;
    if (r < 10) return lit(pick(rng, NUM_LITS));
    return lit(null);
  }
  const r = rng.int(6);
  if (r === 0) return intOperand(rng, depth);
  if (r === 1)
    return {
      kind: "coalesce",
      args: [numOperand(rng, depth - 1), lit(pick(rng, NUM_LITS))]
    };
  if (r === 2)
    return { kind: "func", name: "abs", args: [intOperand(rng, depth - 1)] };
  if (r === 3) return numArith(rng, depth);
  if (r === 4) {
    const arg = numOperand(rng, depth - 1);
    if (rng.int(4) === 0) return { kind: "func", name: "round", args: [arg] };
    const scale =
      rng.int(12) === 0
        ? lit(null)
        : rng.int(10) === 0
          ? lit(pick(rng, [16383, 16384, 20000, -20000] as const))
          : lit(pick(rng, [-3, -2, -1, 0, 1, 2, 3, 5] as const));
    return { kind: "func", name: "round", args: [arg, scale] };
  }
  return { kind: "func", name: "length", args: [sText(rng, depth - 1)] };
}

function sText(rng: Rng, depth: number): Expr {
  if (depth <= 0 || rng.int(2) === 0) return col("s");
  const r = rng.int(3);
  if (r === 0)
    return { kind: "func", name: "lower", args: [sText(rng, depth - 1)] };
  if (r === 1)
    return { kind: "func", name: "upper", args: [sText(rng, depth - 1)] };
  return {
    kind: "coalesce",
    args: [sText(rng, depth - 1), lit(pick(rng, TEXT_LITS))]
  };
}

function textRhs(rng: Rng, depth: number): Expr {
  const r = rng.int(10);
  if (r < 5) return lit(pick(rng, TEXT_LITS));
  if (r < 8) return sText(rng, depth);
  return lit(null);
}

function comparison(rng: Rng, depth: number): Expr {
  const fam = rng.int(10);
  if (fam < 5) {
    const op = pick(rng, ["=", "<>", "<", "<=", ">", ">="] as const);
    return {
      kind: "binary",
      op,
      left: numOperand(rng, depth),
      right: numOperand(rng, depth)
    };
  }
  if (fam < 8) {
    const op = pick(rng, ["=", "<>", "<", "<=", ">", ">="] as const);
    return {
      kind: "binary",
      op,
      left: sText(rng, depth),
      right: textRhs(rng, depth)
    };
  }
  const op = pick(rng, ["=", "<>"] as const);
  const r = rng.int(3);
  const rhs =
    r === 0
      ? lit(rng.int(2) === 0)
      : r === 1
        ? lit(pick(rng, BOOL_TEXT_LITS))
        : col("f");
  return { kind: "binary", op, left: col("f"), right: rhs };
}

function isNullPred(rng: Rng): Expr {
  return {
    kind: "isNull",
    operand: col(pick(rng, ["a", "b", "s", "f", "n", "u", "by"])),
    negated: rng.int(2) === 0
  };
}

const INT_TEXT_LITS = ["1", "05", " 5 ", "0", "-3"];

function inPred(rng: Rng, depth: number): Expr {
  const negated = rng.int(2) === 0;
  const numFam = rng.int(2) === 0;
  const k = 1 + rng.int(3);
  const list: Expr[] = [];
  if (numFam) {
    for (let i = 0; i < k; i++) list.push(lit(pick(rng, NUM_LITS)));
    if (rng.int(3) === 0) list.push(lit(null));
    const operand =
      rng.int(2) === 0 ? col(pick(rng, NUM_COLS)) : numOperand(rng, depth);
    if (operand.kind === "column") {
      if (rng.int(3) === 0) list.push(col(pick(rng, NUM_COLS)));
      if (rng.int(3) === 0) list.push(lit(pick(rng, INT_TEXT_LITS)));
    }
    return { kind: "in", operand, list, negated };
  }
  for (let i = 0; i < k; i++) list.push(lit(pick(rng, TEXT_LITS)));
  if (rng.int(3) === 0) list.push(lit(null));
  if (rng.int(3) === 0) list.push(col("s"));
  return { kind: "in", operand: sText(rng, depth), list, negated };
}

function likePred(rng: Rng, depth: number): Expr {
  return {
    kind: "binary",
    op: rng.int(2) === 0 ? "like" : "ilike",
    left: sText(rng, depth),
    right: lit(pick(rng, PATTERNS))
  };
}

function predicate(rng: Rng, depth: number): Expr {
  if (depth <= 0) {
    const r = rng.int(4);
    if (r === 0) return isNullPred(rng);
    if (r === 1) return likePred(rng, 1);
    if (r === 2) return col("f");
    return comparison(rng, 1);
  }
  const r = rng.int(10);
  if (r < 3) return comparison(rng, depth);
  if (r === 3) return isNullPred(rng);
  if (r === 4) return inPred(rng, depth);
  if (r === 5) return likePred(rng, depth);
  if (r === 6) return { kind: "and", items: predList(rng, depth) };
  if (r === 7) return { kind: "or", items: predList(rng, depth) };
  if (r === 8) return { kind: "not", operand: predicate(rng, depth - 1) };
  return col("f");
}

function predList(rng: Rng, depth: number): Expr[] {
  const k = 2 + rng.int(2);
  const items: Expr[] = [];
  for (let i = 0; i < k; i++) items.push(predicate(rng, depth - 1));
  return items;
}

const DIRECTED: Expr[] = [
  { kind: "binary", op: "=", left: col("a"), right: lit(null) },
  { kind: "isNull", operand: col("a"), negated: false },
  { kind: "isNull", operand: col("a"), negated: true },
  { kind: "binary", op: "<>", left: col("a"), right: col("b") },
  {
    kind: "not",
    operand: { kind: "binary", op: ">", left: col("a"), right: col("b") }
  },
  {
    kind: "in",
    operand: col("a"),
    list: [lit(1), lit(2), lit(null)],
    negated: false
  },
  { kind: "in", operand: col("a"), list: [lit(1), lit(null)], negated: true },
  { kind: "binary", op: "like", left: col("s"), right: lit("a%") },
  { kind: "binary", op: "ilike", left: col("s"), right: lit("A_") },
  {
    kind: "binary",
    op: "like",
    left: col("s"),
    right: { kind: "func", name: "upper", args: [col("s")] }
  },
  {
    kind: "binary",
    op: "ilike",
    left: col("s"),
    right: { kind: "func", name: "concat", args: [col("s"), lit("%")] }
  },
  {
    kind: "binary",
    op: ">",
    left: { kind: "coalesce", args: [col("a"), lit(0)] },
    right: lit(0)
  },
  col("f"),
  { kind: "not", operand: col("f") },
  { kind: "binary", op: "=", left: col("f"), right: lit(true) },
  {
    kind: "or",
    items: [
      { kind: "binary", op: "<", left: col("a"), right: lit(5) },
      col("f")
    ]
  },
  { kind: "binary", op: "<", left: col("s"), right: lit("abc") },
  {
    kind: "binary",
    op: ">=",
    left: { kind: "func", name: "length", args: [col("s")] },
    right: lit(2)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "binary", op: "/", left: col("a"), right: lit(2) },
    right: lit(-1)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "binary", op: "%", left: col("a"), right: lit(3) },
    right: lit(-1)
  },
  {
    kind: "binary",
    op: "=",
    left: {
      kind: "cast",
      to: "int",
      operand: { kind: "coalesce", args: [col("n"), lit(0)] }
    },
    right: lit(3)
  },
  { kind: "binary", op: ">", left: col("s"), right: lit("z") },
  { kind: "binary", op: "<", left: col("s"), right: lit("é") },
  {
    kind: "binary",
    op: "=",
    left: { kind: "binary", op: "+", left: col("n"), right: lit(0.1) },
    right: lit(0.3)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "binary", op: "*", left: col("n"), right: lit(1.0) },
    right: col("n")
  },
  { kind: "in", operand: lit("05"), list: [lit("5"), lit(7)], negated: false },
  { kind: "in", operand: lit("05"), list: [lit("5"), lit(7)], negated: true },
  { kind: "in", operand: col("a"), list: [lit(1), lit("05")], negated: false },
  { kind: "in", operand: lit("a"), list: [lit("b"), col("s")], negated: false },
  {
    kind: "in",
    operand: lit("5"),
    list: [col("a"), col("n")],
    negated: false
  },
  {
    kind: "in",
    operand: col("n"),
    list: [lit(1), lit("05"), col("a"), lit(null)],
    negated: false
  },
  { kind: "binary", op: "=", left: col("a"), right: lit(" 5 ") },
  { kind: "binary", op: "=", left: col("n"), right: lit("2.50") },
  {
    kind: "binary",
    op: "=",
    left: { kind: "binary", op: "/", left: col("a"), right: lit(0) },
    right: lit(1)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "binary", op: "%", left: col("a"), right: lit(0) },
    right: lit(1)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "func", name: "round", args: [col("n"), lit(1)] },
    right: lit(2.5)
  },
  {
    kind: "binary",
    op: ">",
    left: { kind: "func", name: "round", args: [col("n")] },
    right: col("a")
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "func", name: "round", args: [col("a"), lit(2)] },
    right: col("n")
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "func", name: "round", args: [col("n"), lit(16384)] },
    right: { kind: "func", name: "round", args: [col("n"), lit(16383)] }
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "func", name: "round", args: [col("n"), lit(-20000)] },
    right: lit(0)
  },
  {
    kind: "isNull",
    operand: { kind: "func", name: "round", args: [col("n"), lit(null)] },
    negated: false
  },
  {
    kind: "binary",
    op: "=",
    left: {
      kind: "func",
      name: "round",
      args: [
        {
          kind: "binary",
          op: "/",
          left: { kind: "cast", to: "float", operand: col("a") },
          right: lit(2)
        }
      ]
    },
    right: lit(1)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "func", name: "round", args: [lit("2.5")] },
    right: lit(2)
  },
  {
    kind: "binary",
    op: "=",
    left: { kind: "func", name: "length", args: [col("by")] },
    right: lit(4)
  },
  {
    kind: "binary",
    op: ">",
    left: {
      kind: "func",
      name: "length",
      args: [
        {
          kind: "func",
          name: "concat",
          args: [col("f"), col("n"), col("by"), col("u"), col("ts")]
        }
      ]
    },
    right: lit(40)
  }
];

describe.skipIf(!CONN)(
  "PG exprToSql == JS predicateHolds (NULLs, coercions)",
  () => {
    let client: pg.Client;
    let rows: Row[];
    const ROW_COUNT = 48;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: CONN, types: walterTypes });
      await client.connect();
      await client.query(
        "CREATE TEMP TABLE eqv (id int PRIMARY KEY, a int, b int, sm smallint, f8 float8, f4 real, s text, f boolean, n numeric, ts timestamptz, u uuid, by bytea)"
      );
      const rng = new Rng(99);
      for (let id = 1; id <= ROW_COUNT; id++) {
        const a = rng.int(5) === 0 ? null : pick(rng, INT_LITS);
        const b = rng.int(5) === 0 ? null : pick(rng, INT_LITS);
        const sm = rng.int(5) === 0 ? null : pick(rng, SM_LITS);
        const f8 = rng.int(5) === 0 ? null : pick(rng, F8_LITS);
        const f4 = rng.int(5) === 0 ? null : pick(rng, F4_LITS);
        const s = rng.int(5) === 0 ? null : pick(rng, TEXT_LITS);
        const f = pick(rng, [true, false, null] as const);
        const n =
          rng.int(5) === 0
            ? null
            : rng.int(6) === 0
              ? pick(rng, NUM_NONFINITE)
              : pick(rng, NUM_LITS);
        const ts = rng.int(5) === 0 ? null : pick(rng, TS_ROW_LITS);
        const u = rng.int(5) === 0 ? null : pick(rng, UUID_LITS);
        const by = rng.int(5) === 0 ? null : pick(rng, BYTEA_LITS);
        await client.query(
          "INSERT INTO eqv (id, a, b, sm, f8, f4, s, f, n, ts, u, by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [id, a, b, sm, f8, f4, s, f, n, ts, u, by]
        );
      }
      rows = (await client.query("SELECT * FROM eqv")).rows as Row[];
    });

    afterAll(async () => {
      await client?.end();
    });

    async function check(
      pred: Expr,
      paramVal: unknown,
      label: string
    ): Promise<void> {
      threadExpr(pred, EQV_RESOLVER);
      const values: unknown[] = [];
      const bind = (v: unknown) => `$${values.push(v)}`;
      const sql = exprToSql(pred, [paramVal], bind);
      let pgIds: number[] | null = null;
      let pgErr: Error | null = null;
      try {
        const res = await client.query(
          `SELECT id FROM eqv WHERE ${sql}`,
          values
        );
        pgIds = res.rows.map((r: { id: number }) => r.id).sort((x, y) => x - y);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (!(code?.startsWith("22") || code === "0A000"))
          throw new Error(
            `Postgres rejected generated predicate [${label}]:\n  ${sql}\n  ${(e as Error).message}`
          );
        pgErr = e as Error;
      }
      const holds = compileRowPredicate(pred, [paramVal]);
      let jsIds: number[] | null = null;
      let jsErr: Error | null = null;
      try {
        jsIds = rows
          .filter(r => holds(r))
          .map(r => r.id as number)
          .sort((x, y) => x - y);
      } catch (e) {
        jsErr = e as Error;
      }

      if (jsErr !== null && pgErr === null) {
        throw new Error(
          `error divergence [${label}] param=${paramVal}\n` +
            `  SQL : ${sql}\n` +
            `  PG  : ok\n` +
            `  JS  : ${jsErr.message}\n` +
            `  IR  : ${JSON.stringify(pred)}`
        );
      }
      if (pgErr || pgIds === null || jsIds === null) return;

      if (JSON.stringify(pgIds) !== JSON.stringify(jsIds)) {
        const pgSet = new Set(pgIds);
        const jsSet = new Set(jsIds);
        const onlyPg = pgIds.filter(i => !jsSet.has(i));
        const onlyJs = jsIds.filter(i => !pgSet.has(i));
        const offending = [...onlyPg, ...onlyJs]
          .slice(0, 4)
          .map(id => rows.find(r => r.id === id));
        throw new Error(
          `predicate divergence [${label}] param=${paramVal}\n` +
            `  SQL : ${sql}\n` +
            `  only-PG ids: ${onlyPg}\n  only-JS ids: ${onlyJs}\n` +
            `  rows: ${JSON.stringify(offending)}\n` +
            `  IR  : ${JSON.stringify(pred)}`
        );
      }
    }

    it("agrees on hand-picked NULL / coercion corner cases", async () => {
      for (let i = 0; i < DIRECTED.length; i++) {
        for (const p of [-1, 0, 2, 5])
          await check(DIRECTED[i]!, p, `directed#${i}`);
      }
    });

    it("agrees on round scale params across the clamp", async () => {
      const scaled = (): Expr => ({
        kind: "func",
        name: "round",
        args: [col("n"), { kind: "param", index: 1 }]
      });
      for (const p of [0, 2, 5, -2, 16383, 16384, 20000, -20000]) {
        await check(
          {
            kind: "binary",
            op: "=",
            left: scaled(),
            right: {
              kind: "func",
              name: "round",
              args: [col("n"), lit(16383)]
            }
          },
          p,
          `round-scale ${p}`
        );
      }
      await check(
        { kind: "isNull", operand: scaled(), negated: false },
        null,
        "round-scale null"
      );
    });

    it("agrees on numeric literal/param spellings", async () => {
      const SPELLINGS = [
        "1e2",
        "1E2",
        "1e+2",
        "-1e2",
        "1.5e-3",
        ".5",
        "5.",
        ".5e2",
        "2.e3",
        " 2 ",
        "+3",
        "0.50"
      ];
      for (const s of SPELLINGS) {
        for (const op of ["=", ">"] as const) {
          await check(
            { kind: "binary", op, left: col("n"), right: lit(s) },
            null,
            `n ${op} ${JSON.stringify(s)}`
          );
        }
      }
      for (const p of ["1e2", ".5", "+3", " 2 ", "1.5e-3"]) {
        await check(
          {
            kind: "binary",
            op: "=",
            left: col("n"),
            right: { kind: "param", index: 1 }
          },
          p,
          `n = param ${JSON.stringify(p)}`
        );
        await check(
          {
            kind: "binary",
            op: "=",
            left: {
              kind: "binary",
              op: "+",
              left: col("n"),
              right: { kind: "param", index: 1 }
            },
            right: lit(1)
          },
          p,
          `n + param = 1, param ${JSON.stringify(p)}`
        );
      }
    });

    it("agrees on time predicates across param spellings", async () => {
      const ts = col("ts");
      const param = (): Expr => ({ kind: "param", index: 1 });
      const bounds = [
        "2020-06-15T12:30:00Z", // exact row instant, T form
        "2020-06-15 12:30:00+00", // the same instant, space form
        "2020-01-01T00:00:00+00:00", // full-offset form
        "2020-01-01T00:00:00.123Z", // sub-second boundary
        "1969-12-31T23:59:59Z" // pre-epoch
      ];
      for (const op of ["=", "<>", "<", "<=", ">", ">="] as const) {
        for (const b of bounds)
          await check(
            { kind: "binary", op, left: ts, right: param() },
            b,
            `ts ${op} ${b}`
          );
      }
      await check(
        {
          kind: "and",
          items: [
            {
              kind: "binary",
              op: ">=",
              left: ts,
              right: lit("2020-01-01T00:00:00Z")
            },
            { kind: "binary", op: "<=", left: ts, right: param() }
          ]
        },
        "2020-06-15 12:30:00+00",
        "ts between"
      );
      await check(
        {
          kind: "in",
          operand: ts,
          list: [
            lit("2020-01-01T00:00:00Z"),
            lit("2020-06-15 12:30:00+00"),
            lit(null)
          ],
          negated: false
        },
        0,
        "ts in list"
      );
    });

    it("agrees on cast-declared time params ($1::timestamptz)", async () => {
      const ts = col("ts");
      const declared = (): Expr => ({
        kind: "cast",
        to: "timestamptz",
        operand: { kind: "param", index: 1 }
      });
      for (const op of ["=", "<>", "<", "<=", ">", ">="] as const) {
        for (const b of [
          "2020-06-15T12:30:00Z",
          "2020-06-15 12:30:00.000001+00", // one µs off the stored instant
          "2020-01-01T00:00:00.1234565+00" // 7-digit half: rint on both sides
        ])
          await check(
            { kind: "binary", op, left: ts, right: declared() },
            b,
            `ts ${op} $1::timestamptz ${b}`
          );
      }
    });

    it("agrees on float width, non-finite values, and overflow", async () => {
      const bin = (op: "+" | "-" | "*" | "/", l: Expr, r: Expr): Expr => ({
        kind: "binary",
        op,
        left: l,
        right: r
      });
      const cmp = (
        op: "=" | "<>" | "<" | "<=" | ">" | ">=",
        l: Expr,
        r: Expr
      ): Expr => ({ kind: "binary", op, left: l, right: r });
      const OPS = ["=", "<>", "<", "<=", ">", ">="] as const;
      for (const bound of ["NaN", "Infinity", "-Infinity", "0.1", "1e300"]) {
        for (const op of OPS) {
          await check(cmp(op, col("f8"), lit(bound)), 0, `f8 ${op} ${bound}`);
          if (bound !== "1e300")
            await check(cmp(op, col("f4"), lit(bound)), 0, `f4 ${op} ${bound}`);
          await check(cmp(op, col("n"), lit(bound)), 0, `n ${op} ${bound}`);
        }
      }
      for (const op of OPS) {
        await check(cmp(op, col("f8"), col("f4")), 0, `f8 ${op} f4`);
        await check(cmp(op, col("f8"), col("n")), 0, `f8 ${op} n`);
        await check(cmp(op, col("f4"), col("a")), 0, `f4 ${op} a`);
        await check(cmp(op, col("f8"), col("sm")), 0, `f8 ${op} sm`);
      }
      const arith: [Expr, string][] = [
        [cmp(">", bin("+", col("f8"), col("f8")), lit(0)), "f8+f8 > 0"],
        [
          cmp("=", bin("*", col("f8"), col("f8")), lit("Infinity")),
          "f8*f8 = Inf"
        ],
        [cmp("<", bin("-", col("f8"), col("f8")), lit(1)), "f8-f8 < 1"],
        [cmp("=", bin("/", col("f8"), col("f8")), lit(1)), "f8/f8 = 1"],
        [cmp(">", bin("*", col("f4"), col("f4")), lit(0)), "f4*f4 > 0"],
        [cmp(">", bin("+", col("f4"), col("f8")), lit(0)), "f4+f8 > 0"],
        [cmp(">", bin("*", col("sm"), col("sm")), lit(0)), "sm*sm > 0"],
        [cmp("<", bin("+", col("sm"), col("a")), lit(100)), "sm+a < 100"],
        [cmp("=", bin("+", col("n"), lit(1)), lit("Infinity")), "n+1 = Inf"],
        [cmp("=", bin("*", col("n"), lit(0)), lit("NaN")), "n*0 = NaN"]
      ];
      for (const [pred, label] of arith) await check(pred, 0, label);
      const castOf = (
        to: "int" | "int8" | "int2" | "numeric",
        c: Expr
      ): Expr => ({
        kind: "cast",
        to,
        operand: c
      });
      for (const to of ["int", "int8", "int2"] as const) {
        await check(
          cmp(">", castOf(to, col("f8")), lit(0)),
          0,
          `f8::${to} > 0`
        );
      }
      await check(cmp(">", castOf("int", col("f4")), lit(0)), 0, "f4::int > 0");
      await check(
        cmp(">", castOf("numeric", col("f8")), lit("0.1")),
        0,
        "f8::numeric > 0.1"
      );
      await check(
        cmp("=", castOf("numeric", col("f4")), lit("0.3")),
        0,
        "f4::numeric = 0.3"
      );
      await check(cmp(">", castOf("int", col("n")), lit(0)), 0, "n::int > 0");
      await check(
        cmp(">", { kind: "func", name: "round", args: [col("f8")] }, lit(0)),
        0,
        "round(f8) > 0"
      );
      await check(
        cmp(">", { kind: "func", name: "abs", args: [col("f8")] }, lit(1)),
        0,
        "abs(f8) > 1"
      );
      await check(
        cmp("<", { kind: "neg", operand: col("f8") }, lit(0)),
        0,
        "-f8 < 0"
      );
      await check(
        {
          kind: "in",
          operand: col("f8"),
          list: [lit("NaN"), lit("Infinity"), lit(0.5)],
          negated: false
        },
        0,
        "f8 in nonfinite"
      );
    });

    it("agrees on unknown-operand resolution", async () => {
      const bin = (op: "+" | "-" | "*" | "/", l: Expr, r: Expr): Expr => ({
        kind: "binary",
        op,
        left: l,
        right: r
      });
      const cmp = (
        op: "=" | "<>" | "<" | "<=" | ">" | ">=",
        l: Expr,
        r: Expr
      ): Expr => ({ kind: "binary", op, left: l, right: r });
      const num = (value: string): Expr => ({
        kind: "literal",
        value,
        ptype: "numeric"
      });
      const cases: [Expr, unknown, string][] = [
        [cmp(">", bin("*", num("1.5"), lit(2)), col("a")), 0, "1.5 * 2 > a"],
        [cmp(">", col("sm"), num("1.5")), 0, "sm > 1.5"],
        [cmp(">", bin("+", col("sm"), lit("1")), lit(0)), 0, "sm + '1' > 0"],
        [cmp("=", bin("/", col("a"), lit("2")), lit(3)), 0, "a / '2' = 3"],
        [
          cmp(">", bin("*", col("f4"), lit("0.1")), lit(0)),
          0,
          "f4 * '0.1' > 0"
        ],
        [
          cmp("=", bin("*", col("f4"), lit("NaN")), lit("NaN")),
          0,
          "f4 * 'NaN' = NaN"
        ],
        [
          cmp("=", bin("+", col("n"), lit("0.10")), col("n")),
          0,
          "n + '0.10' = n"
        ],
        [
          cmp(">", bin("-", col("f8"), lit("1e300")), lit(0)),
          0,
          "f8 - '1e300' > 0"
        ],
        [cmp(">", bin("+", col("b"), lit(null)), lit(0)), 0, "b + NULL > 0"],
        [
          cmp(">", bin("+", col("sm"), { kind: "param", index: 1 }), lit(0)),
          "1",
          "sm + $1 > 0"
        ],
        [
          cmp("=", bin("/", col("a"), { kind: "param", index: 1 }), lit(2)),
          "3",
          "a / $1 = 2"
        ]
      ];
      for (const [pred, param, label] of cases) await check(pred, param, label);
    });

    it("agrees on uuid/bool/bytea constant spellings", async () => {
      const param = (): Expr => ({ kind: "param", index: 1 });
      const cmp = (
        op: "=" | "<>" | "<" | "<=" | ">" | ">=",
        r: Expr
      ): Expr => ({
        kind: "binary",
        op,
        left: col("u"),
        right: r
      });
      const CANON = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const spellings = [
        CANON,
        CANON.toUpperCase(),
        `{${CANON}}`,
        CANON.replace(/-/g, "")
      ];
      for (const op of ["=", "<>", "<", "<=", ">", ">="] as const) {
        for (const s of spellings)
          await check(cmp(op, param()), s, `u ${op} ${s}`);
      }
      await check(cmp("=", lit(CANON.toUpperCase())), 0, "u = upper literal");
      await check(
        {
          kind: "in",
          operand: col("u"),
          list: [
            lit(CANON.toUpperCase()),
            lit("0F000000000000000000000000000000"),
            lit(null)
          ],
          negated: false
        },
        0,
        "u in spellings"
      );
      await check(
        { kind: "in", operand: col("u"), list: [lit(CANON)], negated: true },
        0,
        "u not in"
      );
      for (const s of [...BOOL_TEXT_LITS, "TRUE", "Fal", " f "]) {
        await check(
          { kind: "binary", op: "=", left: col("f"), right: lit(s) },
          0,
          `f = '${s}'`
        );
      }
      await check(
        { kind: "binary", op: "<>", left: col("f"), right: lit("yes") },
        0,
        "f <> 'yes'"
      );
      await check(
        { kind: "binary", op: ">=", left: col("f"), right: lit("f") },
        0,
        "f >= 'f'"
      );
      await check(
        { kind: "binary", op: "=", left: col("f"), right: param() },
        "f",
        "f = $1 'f'"
      );
      const by = (op: "=" | "<", r: Expr): Expr => ({
        kind: "binary",
        op,
        left: col("by"),
        right: r
      });
      await check(by("=", lit("\\xDEADBEEF")), 0, "by = upper hex");
      await check(by("=", lit("\\xde ad be ef")), 0, "by = spaced hex");
      await check(by("=", lit("\\x")), 0, "by = empty");
      await check(by("<", lit("\\xFF")), 0, "by < hex");
      await check(
        by("=", param()),
        Buffer.from("deadbeef", "hex"),
        "by = $1 buffer"
      );
    });

    it("agrees on = ANY($1) / <> ALL($1) array params (raw spelling on PG, fold on JS)", async () => {
      async function checkAny(
        where: string,
        arr: unknown,
        label: string
      ): Promise<void> {
        const raw = await client.query(
          `SELECT id FROM eqv WHERE ${where} ORDER BY id`,
          [arr]
        );
        const pgIds = raw.rows.map((r: { id: number }) => r.id);
        const query = await parseSql(`SELECT id FROM eqv WHERE ${where}`);
        expandStars(query, EQV_CATALOG);
        foldArrayParams({ query, collections: [] }, [arr]);
        threadExpr(query.where!, EQV_RESOLVER);
        const holds = compileRowPredicate(query.where!, [arr]);
        const jsIds = rows
          .filter(r => holds(r))
          .map(r => r.id as number)
          .sort((x, y) => x - y);
        expect(jsIds, label).toEqual(pgIds);
        const values: unknown[] = [];
        const sql = exprToSql(query.where!, [arr], v => `$${values.push(v)}`);
        const rendered = await client.query(
          `SELECT id FROM eqv WHERE ${sql} ORDER BY id`,
          values
        );
        expect(
          rendered.rows.map((r: { id: number }) => r.id),
          `${label} (rendered)`
        ).toEqual(pgIds);
      }

      const CANON = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      await checkAny("a = ANY ($1)", [5, null, "05"], "a any mixed");
      await checkAny("a <> ALL ($1)", [1, null], "a all with null");
      await checkAny("a <> ALL ($1)", [1, 2], "a all plain");
      await checkAny("a = ANY ($1)", [], "a any empty");
      await checkAny("a <> ALL ($1)", [], "a all empty (null rows too)");
      await checkAny("a = ANY ($1)", null, "a any null array");
      await checkAny("a <> ALL ($1)", null, "a all null array");
      await checkAny("s = ANY ($1)", ["a", "Ä", 42], "s any with int elem");
      await checkAny(
        "u = ANY ($1)",
        [CANON.toUpperCase(), "0f000000-0000-0000-0000-000000000000"],
        "u any uppercase"
      );
      await checkAny(
        "ts = ANY ($1)",
        ["2020-06-15 12:30:00+00", new Date("2020-01-01T00:00:00Z")],
        "ts any spellings + Date"
      );
      await checkAny(
        "n = ANY ($1)",
        ["2.5", 1.23, "0.30"],
        "n any decimal text"
      );
      await checkAny("f = ANY ($1)", ["yes", false], "f any bool text");
    });

    it("agrees on 800 randomized type-correct predicates", async () => {
      const rng = new Rng(20260610);
      const paramPool = [-2, -1, 0, 1, 2, 3, 5];
      for (let iter = 0; iter < 800; iter++) {
        const pred = predicate(rng, 2 + rng.int(2));
        await check(pred, pick(rng, paramPool), `rand#${iter}`);
      }
    }, 60000);
  }
);

describe.skipIf(!CONN)("PG fetchWindow == JS window order", () => {
  const TABLE = "walter_eqv_win";
  const USERS = "walter_eqv_usr";
  let pool: pg.Pool;
  let pgSrc: PgRowSource;
  let memSrc: MemRowSource;

  const key = (
    column: string,
    o: Partial<WindowSortKey> = {}
  ): WindowSortKey => ({
    alias: "x",
    column,
    anchor: true,
    desc: false,
    nullsFirst: false,
    cls: "number",
    ...o
  });
  const PKK = key("id");
  const anchorOnly: FromItem = { kind: "table", name: TABLE, alias: "x" };
  const WIN_RESOLVER = new PlanScope(
    [{ name: TABLE, alias: "x" }],
    catalogOf({
      columnTypes: {
        [TABLE]: {
          id: "int4",
          org: "int4",
          room: "text",
          ts: "timestamptz",
          num: "numeric"
        }
      }
    })
  ).classOf;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: CONN, max: 2, types: walterTypes });
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`DROP TABLE IF EXISTS ${USERS}`);
    await pool.query(
      `CREATE TABLE ${TABLE} (id int PRIMARY KEY, org int NOT NULL, ` +
        `room text NOT NULL, ts timestamptz, num numeric)`
    );
    await pool.query(`CREATE TABLE ${USERS} (id int PRIMARY KEY, name text)`);
    const TS = [
      null,
      "2020-01-01T00:00:00Z",
      "2020-01-01T00:00:00.123Z", // sub-second: a textual cursor would lose it
      "2020-06-15T12:30:00Z",
      "1969-12-31T23:59:59Z", // pre-epoch
      "2020-06-15T12:30:00Z" // duplicate: pk tiebreak under a Date bound
    ];
    const NUM = [null, "0", "-1.5", "2.25", "1000000.000001", "2.25", "0.1"];
    const rng = new Rng(4242);
    for (let id = 1; id <= 60; id++) {
      await pool.query(
        `INSERT INTO ${TABLE} (id, org, room, ts, num) VALUES ($1,$2,$3,$4,$5)`,
        [
          id,
          1 + rng.int(2),
          pick(rng, ["a", "b"]),
          pick(rng, TS),
          pick(rng, NUM)
        ]
      );
    }
    await pool.query(`INSERT INTO ${USERS} (id, name) VALUES (1, 'Ä')`);
    pgSrc = new PgRowSource(pool, { defaultSchema: "public" });
    const byTable = new Map<string, Row[]>();
    for (const t of [TABLE, USERS]) {
      byTable.set(t, (await pool.query(`SELECT * FROM ${t}`)).rows as Row[]);
    }
    memSrc = new MemRowSource(t => byTable.get(t) ?? []);
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool?.query(`DROP TABLE IF EXISTS ${USERS}`);
    await pool?.end();
  });

  async function walk(
    source: RowSource,
    order: readonly WindowSortKey[],
    from: FromItem,
    correlationColumns: readonly string[],
    values: readonly (readonly unknown[])[],
    pageSize: number
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const parts = new Map<string, WindowPartition>();
    for (const v of values) {
      parts.set(stableStringify(v), { value: v });
      out.set(stableStringify(v), []);
    }
    let pending = [...parts.keys()];
    while (pending.length > 0) {
      const { rows } = await source.fetchWindow({
        anchorTable: TABLE,
        anchorAlias: "x",
        order,
        pageSize,
        fetch: { from, where: undefined },
        correlationColumns,
        partitions: pending.map(k => parts.get(k)!),
        params: []
      });
      const got = new Map<string, Row[]>();
      for (const row of rows) {
        const k = stableStringify(corrValue(row, correlationColumns));
        let arr = got.get(k);
        if (!arr) got.set(k, (arr = []));
        arr.push(row);
      }
      const next: string[] = [];
      for (const k of pending) {
        const arr = got.get(k) ?? [];
        out.get(k)!.push(...arr.map(r => r.id as number));
        if (arr.length === pageSize) {
          parts.get(k)!.after = windowTuple(arr[arr.length - 1]!, order);
          next.push(k);
        }
      }
      pending = next;
    }
    return out;
  }

  async function checkOrder(
    order: readonly WindowSortKey[],
    correlationColumns: readonly string[],
    values: readonly (readonly unknown[])[],
    label: string,
    from: FromItem = anchorOnly
  ): Promise<void> {
    for (const pageSize of [3, 7]) {
      const pgIds = await walk(
        pgSrc,
        order,
        from,
        correlationColumns,
        values,
        pageSize
      );
      const memIds = await walk(
        memSrc,
        order,
        from,
        correlationColumns,
        values,
        pageSize
      );
      expect(pgIds, `${label} pageSize=${pageSize}`).toEqual(memIds);
      let n = 0;
      for (const ids of pgIds.values()) n += ids.length;
      expect(n, `${label} returned no rows`).toBeGreaterThan(0);
    }
  }

  it("pages by timestamptz with Date keyset bounds", async () => {
    await checkOrder(
      [key("ts", { desc: true, cls: "time" }), PKK],
      [],
      [[]],
      "ts desc"
    );
    await checkOrder(
      [key("ts", { nullsFirst: true, cls: "time" }), PKK],
      [],
      [[]],
      "ts asc nulls first"
    );
  });

  it("pages by numeric with canonical-decimal keyset bounds", async () => {
    await checkOrder([key("num"), PKK], [], [[]], "num asc");
  });

  it("fetchWhereIn matches on composite key tuples", async () => {
    const keys = [
      [1, "a"],
      [2, "b"]
    ];
    const pgRes = await pgSrc.fetchWhereIn(TABLE, ["org", "room"], keys);
    const memRes = await memSrc.fetchWhereIn(TABLE, ["org", "room"], keys);
    const ids = (rows: Row[]) =>
      rows.map(r => r.id as number).sort((x, y) => x - y);
    expect(ids(pgRes.rows)).toEqual(ids(memRes.rows));
    expect(pgRes.rows.length).toBeGreaterThan(0);
  });

  it("composite fetchWhereIn survives the bind-parameter cap (chunked)", async () => {
    const keys: [number, string][] = [
      [1, "a"],
      [1, "b"],
      [2, "a"],
      [2, "b"]
    ];
    for (let i = 0; i < 40_000; i++) keys.push([1000 + i, "z"]);
    const pgRes = await pgSrc.fetchWhereIn(TABLE, ["org", "room"], keys);
    const memRes = await memSrc.fetchWhereIn(TABLE, ["org", "room"], keys);
    const ids = (rows: Row[]) =>
      rows.map(r => r.id as number).sort((x, y) => x - y);
    expect(ids(pgRes.rows)).toEqual(ids(memRes.rows));
    expect(pgRes.rows.length).toBe(60);
    expect(pgRes.snap.xmin).toBeGreaterThan(0n);
  }, 30_000);

  it("fetchWindow survives the bind-parameter cap across partitions (chunked)", async () => {
    const values: number[] = [1, 2];
    for (let i = 0; i < 33_000; i++) values.push(1000 + i);
    const req = (source: RowSource) =>
      source.fetchWindow({
        anchorTable: TABLE,
        anchorAlias: "x",
        order: [PKK],
        pageSize: 100,
        fetch: { from: anchorOnly, where: undefined },
        correlationColumns: ["org"],
        partitions: values.map(v => ({ value: [v], after: [0] })),
        params: []
      });
    const pgRes = await req(pgSrc);
    const memRes = await req(memSrc);
    const byOrg = (rows: Row[]) => {
      const m = new Map<number, number[]>();
      for (const r of rows) {
        const org = r.org as number;
        if (!m.has(org)) m.set(org, []);
        m.get(org)!.push(r.id as number);
      }
      return m;
    };
    expect(byOrg(pgRes.rows)).toEqual(byOrg(memRes.rows));
    expect(pgRes.rows.length).toBe(60);
  }, 30_000);

  it("pages composite (org, room) partitions with bound tuple keys", async () => {
    await checkOrder(
      [key("ts", { desc: true, cls: "time" }), PKK],
      ["org", "room"],
      [
        [1, "a"],
        [1, "b"],
        [2, "a"],
        [2, "b"]
      ],
      "composite partitions"
    );
  });

  const joined = (joinType: "inner" | "left"): FromItem => ({
    kind: "join",
    joinType,
    left: anchorOnly,
    right: { kind: "table", name: USERS, alias: "u" },
    on: {
      kind: "binary",
      op: "=",
      left: { kind: "column", table: "u", name: "id", ptype: "int" },
      right: { kind: "column", table: "x", name: "org", ptype: "int" },
      ptype: "bool"
    }
  });
  const partnerOrder = (): WindowSortKey[] => [
    key("name", { alias: "u", anchor: false, cls: "text" }),
    key("ts", { cls: "time" }),
    PKK
  ];

  it("pages a joined window ordered by a partner column (hidden __w)", async () => {
    const order = partnerOrder();
    await checkOrder(order, [], [[]], "inner join", joined("inner"));
    await checkOrder(order, [], [[]], "left join", joined("left"));
  });

  it("reveal fetch (targeted / all / unbounded) matches on both sources", async () => {
    const order = partnerOrder();
    const from = joined("left");
    const revealFetch = async (
      source: RowSource,
      after: readonly unknown[] | undefined,
      reveal: Reveal
    ): Promise<number[]> => {
      const { rows } = await source.fetchWindow({
        anchorTable: TABLE,
        anchorAlias: "x",
        order,
        pageSize: 10,
        fetch: { from, where: undefined },
        correlationColumns: [],
        partitions: [{ value: [], after }],
        params: [],
        reveal
      });
      return rows.map(r => r.id as number).sort((a, b) => a - b);
    };

    const page = await pgSrc.fetchWindow({
      anchorTable: TABLE,
      anchorAlias: "x",
      order,
      pageSize: 10,
      fetch: { from, where: undefined },
      correlationColumns: [],
      partitions: [{ value: [] }],
      params: []
    });
    const after = windowTuple(page.rows[9]!, order);

    const target: Reveal = [
      { columns: [{ alias: "x", column: "org" }], tuples: [[1]] }
    ];
    const both: Reveal = [
      { columns: [{ alias: "x", column: "org" }], tuples: [[1], [2]] }
    ];
    for (const [label, bound, reveal] of [
      ["targeted", after, target],
      ["multi-tuple", after, both],
      ["targeted unbounded", undefined, target]
    ] as const) {
      const pgIds = await revealFetch(pgSrc, bound, reveal);
      const memIds = await revealFetch(memSrc, bound, reveal);
      expect(pgIds, label).toEqual(memIds);
      expect(pgIds.length, `${label} returned no rows`).toBeGreaterThan(0);
    }
  });

  it("seeds a scoped read whose predicate skips $1", async () => {
    const pred: Expr = {
      kind: "binary",
      op: "=",
      left: { kind: "column", table: "x", name: "room" },
      right: { kind: "param", index: 2 }
    };
    threadExpr(pred, WIN_RESOLVER);
    const params = [999, "a"];
    const ids = (rows: Row[]) =>
      rows.map(r => r.id as number).sort((a, b) => a - b);
    const pgRes = await pgSrc.scopedRows(TABLE, pred, params);
    const memRes = await memSrc.scopedRows(TABLE, pred, params);
    expect(ids(pgRes.rows)).toEqual(ids(memRes.rows));
    expect(pgRes.rows.length).toBeGreaterThan(0);
  });

  it("pages a window whose WHERE skips $1", async () => {
    const pred: Expr = {
      kind: "binary",
      op: "=",
      left: { kind: "column", table: "x", name: "room" },
      right: { kind: "param", index: 2 }
    };
    threadExpr(pred, WIN_RESOLVER);
    const req = {
      anchorTable: TABLE,
      anchorAlias: "x",
      order: [PKK],
      pageSize: 100,
      fetch: { from: anchorOnly, where: pred },
      correlationColumns: [],
      partitions: [{ value: [] }],
      params: [999, "a"]
    };
    const ids = (rows: Row[]) => rows.map(r => r.id as number);
    const pgRes = await pgSrc.fetchWindow(req);
    const memRes = await memSrc.fetchWindow(req);
    expect(ids(pgRes.rows)).toEqual(ids(memRes.rows));
    expect(pgRes.rows.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!CONN)("PG GROUP BY == dataflow aggregate", () => {
  let client: pg.Client;
  let ops: RowOp[];
  const TYPES = {
    eqvg: { id: "int4", a: "int4", b: "int4", s: "text", n: "numeric" }
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: CONN, types: walterTypes });
    await client.connect();
    await client.query(
      "CREATE TEMP TABLE eqvg (id int PRIMARY KEY, a int, b int, s text, n numeric)"
    );
    const rng = new Rng(7);
    for (let id = 1; id <= 40; id++) {
      await client.query(
        "INSERT INTO eqvg (id, a, b, s, n) VALUES ($1,$2,$3,$4,$5)",
        [
          id,
          rng.int(5) === 0 ? null : pick(rng, [1, 2, 3]),
          rng.int(5) === 0 ? null : pick(rng, [-1, 0, 1]),
          rng.int(5) === 0 ? null : pick(rng, ["a", "A", "ab", "B", ""]),
          rng.int(5) === 0 ? null : pick(rng, [0.1, 0.2, 1.5, -1])
        ]
      );
    }
    const res = await client.query("SELECT * FROM eqvg");
    ops = res.rows.map((r: Row): RowOp => ({
      table: "eqvg",
      kind: "insert",
      newRow: r
    }));
  });

  afterAll(async () => {
    await client?.end();
  });

  const cell = (v: unknown) => (v === null ? "∅" : String(v));
  const norm = (rows: Row[]) =>
    rows
      .map(r =>
        JSON.stringify(
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))
        )
      )
      .sort();

  async function checkAgg(walterSql: string, pgSql = walterSql): Promise<void> {
    const h = await IncrementalHarness.create(
      walterSql,
      [],
      { columnTypes: TYPES },
      { eqvg: ["id"] }
    );
    h.seed(ops);
    const pgRows = (await client.query(pgSql)).rows as Row[];
    expect(norm(h.snapshotRows() as Row[]), walterSql).toEqual(norm(pgRows));
  }

  it("agrees across group exprs and aggregates", async () => {
    const groups: [string, string][] = [
      ["a", "a"],
      ["b", "b"],
      ["s", "s"],
      ["lower(s)", 'lower(s COLLATE "C")']
    ];
    const aggs: [string, string][] = [
      ["count(*) AS c", "count(*) AS c"],
      ["sum(a) AS t", "sum(a) AS t"],
      ["min(a) AS lo, max(a) AS hi", "min(a) AS lo, max(a) AS hi"],
      [
        "min(s) AS lo, max(s) AS hi",
        'min(s COLLATE "C") AS lo, max(s COLLATE "C") AS hi'
      ]
    ];
    for (const [gw, gp] of groups) {
      for (const [aw, ap] of aggs) {
        await checkAgg(
          `SELECT ${gw} AS g, ${aw} FROM eqvg GROUP BY ${gw}`,
          `SELECT ${gp} AS g, ${ap} FROM eqvg GROUP BY ${gp}`
        );
      }
    }
  }, 30000);

  it("dependent columns ride a grouped PK", async () => {
    await checkAgg(
      "SELECT id AS g, s AS dep, count(*) AS c FROM eqvg GROUP BY id"
    );
  });

  it("multi-column group keys agree when the select covers them", async () => {
    await checkAgg(
      "SELECT a AS g1, b AS g2, count(*) AS c FROM eqvg GROUP BY a, b"
    );
  });

  it("hashes by value: int8 joins int4, numeric scales collapse", async () => {
    await client.query(
      "CREATE TEMP TABLE eqvi (id int PRIMARY KEY, a int8, b int4, n numeric, m numeric)"
    );
    await client.query(
      "INSERT INTO eqvi VALUES (1, 5, 5, 1.5, 1.50), (2, 6, 5, 1.50, 2), " +
        "(3, 7, 6, 2.0, 1.5), (4, NULL, 7, NULL, 2.00)"
    );
    const types = {
      eqvi: { id: "int4", a: "int8", b: "int4", n: "numeric", m: "numeric" }
    };
    const ops = (await client.query("SELECT * FROM eqvi")).rows.map(
      (r: Row): RowOp => ({
        table: "eqvi",
        kind: "insert",
        newRow: r
      })
    );
    for (const sql of [
      "SELECT count(*) AS c, sum(b) AS s FROM eqvi GROUP BY n",
      "SELECT count(DISTINCT n) AS c FROM eqvi",
      "SELECT x.id AS xid, y.id AS yid FROM eqvi x JOIN eqvi y ON y.b = x.a",
      "SELECT x.id AS id FROM eqvi x WHERE EXISTS (SELECT 1 FROM eqvi y WHERE y.n = x.m)"
    ]) {
      const h = await IncrementalHarness.create(
        sql,
        [],
        { columnTypes: types },
        { eqvi: ["id"] }
      );
      h.seed(ops);
      const pgRows = (await client.query(sql)).rows as Row[];
      expect(norm(h.snapshotRows() as Row[]), sql).toEqual(norm(pgRows));
    }
  });

  it("GROUP BY resolves a select alias like Postgres: input column first", async () => {
    await checkAgg(
      "SELECT a + 1 AS g, count(*) AS c FROM eqvg GROUP BY g",
      "SELECT a + 1 AS g, count(*) AS c FROM eqvg GROUP BY g"
    );
    const shadowed = "SELECT b + 1 AS a, count(*) AS c FROM eqvg GROUP BY a";
    await expect(client.query(shadowed)).rejects.toThrow(
      /"eqvg.b" must appear in the GROUP BY clause/
    );
    await expect(checkAgg(shadowed)).rejects.toThrow(
      /"eqvg.b" must appear in the GROUP BY clause/
    );
  });
});

describe.skipIf(!CONN)("PG float aggregates == dataflow", () => {
  let client: pg.Client;
  let ops: RowOp[];
  const TYPES = { eqvf: { id: "int4", g: "int4", f8: "float8", f4: "float4" } };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: CONN, types: walterTypes });
    await client.connect();
    await client.query(
      "CREATE TEMP TABLE eqvf (id int PRIMARY KEY, g int, f8 float8, f4 real)"
    );
    const rows: [number, number | null, number | null][] = [
      [1, 0.5, 0.25],
      [1, -2.25, 1.5],
      [1, 1048576.125, -0.5],
      [2, 0.0009765625, 8388608],
      [2, null, null],
      [2, 33554432, -0.125]
    ];
    for (const [i, [g, f8, f4]] of rows.entries()) {
      await client.query("INSERT INTO eqvf VALUES ($1,$2,$3,$4)", [
        i + 1,
        g,
        f8,
        f4
      ]);
    }
    const res = await client.query("SELECT * FROM eqvf");
    ops = res.rows.map((r: Row): RowOp => ({
      table: "eqvf",
      kind: "insert",
      newRow: r
    }));
  });

  afterAll(async () => {
    await client?.end();
  });

  const norm = (rows: Row[]) =>
    rows
      .map(r =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, v === null ? "∅" : String(v)])
          )
        )
      )
      .sort();

  it("sum/avg(float8), avg(real) and sum(real::float8) agree bytewise", async () => {
    for (const agg of [
      "sum(f8) AS v",
      "avg(f8) AS v",
      "avg(f4) AS v",
      "sum(f4::float8) AS v",
      "sum(DISTINCT f8) AS v"
    ]) {
      const sql = `SELECT g AS g, ${agg} FROM eqvf GROUP BY g`;
      const h = await IncrementalHarness.create(
        sql,
        [],
        { columnTypes: TYPES },
        { eqvf: ["id"] }
      );
      h.seed(ops);
      const pgRows = (await client.query(sql)).rows as Row[];
      expect(norm(h.snapshotRows() as Row[]), sql).toEqual(norm(pgRows));
    }
  });

  it("float sum overflow raises PG's exact error on both evaluators", async () => {
    const pgErr = (await client
      .query(
        "SELECT sum(x) FROM (VALUES (1.5e308::float8),(1e308::float8)) t(x)"
      )
      .then(
        () => null,
        (e: Error & { code?: string }) => e
      ))!;
    expect(pgErr.code).toBe("22003");
    const h = await IncrementalHarness.create(
      "SELECT g AS g, sum(f8) AS v FROM eqvf GROUP BY g",
      [],
      { columnTypes: TYPES },
      { eqvf: ["id"] }
    );
    expect(() =>
      h.seed([
        { table: "eqvf", kind: "insert", newRow: { id: 1, g: 1, f8: 1.5e308 } },
        { table: "eqvf", kind: "insert", newRow: { id: 2, g: 1, f8: 1e308 } }
      ])
    ).toThrow(pgErr.message);
  });
});

describe.skipIf(!CONN)(
  "uuid shape: seed and WAL agree through the manager",
  () => {
    const TABLE = "walter_uuid_shape";
    const CANON = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    let pool: pg.Pool;
    let admin: pg.Client;

    beforeAll(async () => {
      await initParser();
      admin = new pg.Client({ connectionString: CONN, types: walterTypes });
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await admin.query(
        `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, score int)`
      );
      await admin.query(`INSERT INTO ${TABLE} VALUES ($1, 1)`, [CANON]);
      pool = new pg.Pool({
        connectionString: CONN,
        max: 2,
        types: walterTypes
      });
    });

    afterAll(async () => {
      await pool?.end();
      await admin?.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await admin?.end();
    });

    const freshXid = async () =>
      Number(
        (
          (await admin.query("SELECT pg_current_xact_id()::xid::text AS x"))
            .rows[0] as { x: string }
        ).x
      );

    it("an uppercase uuid param matches on seed AND on the WAL path", async () => {
      const catalog = new SchemaCatalog();
      catalog.setKeyColumns(`public.${TABLE}`, ["id"]);
      catalog.setColumnTypes(`public.${TABLE}`, { id: "uuid", score: "int4" });
      const mgr = new SubscriptionManager(
        new PgRowSource(pool, { defaultSchema: "public" }),
        catalog,
        "public",
        0
      );
      const diffs: unknown[] = [];
      const sub: ViewSubscriber = {
        id: "s1",
        snapshot() {},
        diff(c) {
          diffs.push(JSON.parse(c));
        },
        failed() {}
      };
      const shape = await mgr.subscribe(sub, {
        sql: `SELECT id, score FROM ${TABLE} WHERE id = $1`,
        params: [CANON.toUpperCase()]
      });
      expect(shape.materializer.snapshot()).toHaveLength(1);

      mgr.handleTxn(
        commit(await freshXid(), [
          {
            table: `public.${TABLE}`,
            kind: "update",
            oldRow: { id: CANON, score: 1 },
            newRow: { id: CANON, score: 2 }
          }
        ])
      );
      const current = () =>
        shape.materializer.snapshot() as { score?: number }[];
      const deadline = Date.now() + 5000;
      while (!(current().length === 1 && current()[0]!.score === 2)) {
        if (Date.now() > deadline)
          throw new Error(`WAL update lost: view=${JSON.stringify(current())}`);
        await new Promise(r => setTimeout(r, 20));
      }
      expect(diffs.length).toBeGreaterThan(0);
      mgr.unsubscribe(shape, "s1");
    }, 20000);

    it("an uppercase uuid ARRAY param (= ANY) matches on seed AND on the WAL path", async () => {
      const catalog = new SchemaCatalog();
      catalog.setKeyColumns(`public.${TABLE}`, ["id"]);
      catalog.setColumnTypes(`public.${TABLE}`, { id: "uuid", score: "int4" });
      const mgr = new SubscriptionManager(
        new PgRowSource(pool, { defaultSchema: "public" }),
        catalog,
        "public",
        0
      );
      const diffs: unknown[] = [];
      const sub: ViewSubscriber = {
        id: "s1",
        snapshot() {},
        diff(c) {
          diffs.push(JSON.parse(c));
        },
        failed() {}
      };
      const shape = await mgr.subscribe(sub, {
        sql: `SELECT id, score FROM ${TABLE} WHERE id = ANY ($1)`,
        params: [[CANON.toUpperCase(), "ffffffff-ffff-ffff-ffff-ffffffffffff"]]
      });
      expect(shape.materializer.snapshot()).toHaveLength(1);

      mgr.handleTxn(
        commit(await freshXid(), [
          {
            table: `public.${TABLE}`,
            kind: "update",
            oldRow: { id: CANON, score: 1 },
            newRow: { id: CANON, score: 3 }
          }
        ])
      );
      const current = () =>
        shape.materializer.snapshot() as { score?: number }[];
      const deadline = Date.now() + 5000;
      while (!(current().length === 1 && current()[0]!.score === 3)) {
        if (Date.now() > deadline)
          throw new Error(`WAL update lost: view=${JSON.stringify(current())}`);
        await new Promise(r => setTimeout(r, 20));
      }
      expect(diffs.length).toBeGreaterThan(0);
      mgr.unsubscribe(shape, "s1");
    }, 20000);
  }
);
