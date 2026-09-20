import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { walterTypes } from "../src/parser/pgtypes";
import { UnsupportedSqlError, type Expr } from "../src/parser/ir";
import { compileRowPredicate } from "../src/planner/compile";
import { exprToSql, PgRowSource, SESSION_PINS } from "../src/lazy/pg-source";
import { MemRowSource, type RowSource } from "../src/lazy/rowsource";
import { windowTuple, type WindowSortKey } from "../src/lazy/window";
import { threadExpr } from "../src/planner/types";
import { PlanScope } from "../src/planner/scope";
import { canonicalize, type Row } from "../src/ivm/zset";
import { CdcSource } from "../src/cdc/replication";
import { SchemaCatalog } from "../src/parser/catalog";
import type { TxnBatch } from "../src/cdc/types";
import { catalogOf } from "./support";
import { ownDatabase } from "./pg";

const CONN = ownDatabase("time_tz");
const TABLE = "walter_tz_probe";
const TZS = ["UTC", "America/New_York", "Pacific/Kiritimati"] as const;

const col = (name: string): Expr => ({ kind: "column", table: TABLE, name });
const lit = (value: string | null): Expr =>
  value === null
    ? { kind: "literal", value }
    : { kind: "literal", value, ptype: "text", quoted: true };
const cmp = (
  op: "=" | "<>" | "<" | "<=" | ">" | ">=",
  l: Expr,
  r: Expr
): Expr => ({ kind: "binary", op, left: l, right: r });

const scopeOf = (types: Record<string, string>) =>
  new PlanScope(
    [{ name: TABLE, alias: TABLE }],
    catalogOf({ columnTypes: { [TABLE]: types } })
  ).classOf;
const RESOLVER = scopeOf({
  id: "int4",
  d: "date",
  tsn: "timestamp",
  tstz: "timestamptz"
});

const SEED: [number, string | null, string | null, string | null][] = [
  [1, "2024-01-15", "2024-01-15 00:00:00", "2024-01-15 00:00:00+00"],
  [2, "2024-01-14", "2024-01-15 02:00:00", "2024-01-15 02:00:00+00"],
  [3, "2024-06-30", "2024-01-15 10:30:00.123456", "2024-01-14 23:00:00+00"],
  [4, "1969-12-31", "2024-01-14 23:59:59", null],
  [5, null, null, null],
  [6, "2024-01-15", "2024-03-10 02:30:00", null],
  [7, "2024-03-10", "2024-03-10 03:00:00", null],
  [8, "infinity", null, null],
  [10, null, null, "2024-01-15 02:00:00.000456+00"],
  [11, null, null, "2024-01-15 02:00:00.000123+00"]
];

let admin: pg.Client;

async function agree(
  pred: Expr,
  label: string,
  params: unknown[] = []
): Promise<void> {
  threadExpr(pred, RESOLVER);
  const holds = compileRowPredicate(pred, params);
  const values: unknown[] = [];
  const sql = exprToSql(pred, params, v => `$${values.push(v)}`);
  const pgIds = (
    await admin.query(
      `SELECT id FROM ${TABLE} WHERE ${sql} ORDER BY id`,
      values
    )
  ).rows.map((r: { id: number }) => r.id);
  const rows = (await admin.query(`SELECT * FROM ${TABLE}`)).rows as Row[];
  const jsIds = rows
    .filter(r => holds(r))
    .map(r => r.id as number)
    .sort((a, b) => a - b);
  expect(jsIds, label).toEqual(pgIds);
}

beforeAll(async () => {
  if (!CONN) return;
  admin = new pg.Client({ connectionString: CONN, types: walterTypes });
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await admin.query(
    `CREATE TABLE ${TABLE} ` +
      `(id int PRIMARY KEY, d date, tsn timestamp, tstz timestamptz)`
  );
  for (const [id, d, tsn, tstz] of SEED)
    await admin.query(`INSERT INTO ${TABLE} VALUES ($1, $2, $3, $4)`, [
      id,
      d,
      tsn,
      tstz
    ]);
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await admin.end();
});

describe("canonical time values are Postgres text (offline)", () => {
  const dateOf = (t: string) => walterTypes.getTypeParser(1082)(t);
  const tsOf = (t: string) => walterTypes.getTypeParser(1114)(t);
  const tstzOf = (t: string) => walterTypes.getTypeParser(1184)(t);

  it("date and naive timestamp parse to their PG text, any TZ", () => {
    for (const tz of TZS) {
      process.env.TZ = tz;
      expect(canonicalize(dateOf("2024-01-15")), tz).toBe("2024-01-15");
      expect(canonicalize(tsOf("2024-03-10 02:30:00")), tz).toBe(
        "2024-03-10 02:30:00"
      );
      expect(canonicalize(tsOf("2024-01-15 10:30:00.123456")), tz).toBe(
        "2024-01-15 10:30:00.123456"
      );
      expect(canonicalize(dateOf("infinity")), tz).toBe("infinity");
    }
  });

  it("timestamptz parses to its PG text (µs survive), any TZ", () => {
    for (const tz of TZS) {
      process.env.TZ = tz;
      expect(canonicalize(tstzOf("2024-01-15 02:00:00.123456+00")), tz).toBe(
        "2024-01-15 02:00:00.123456+00"
      );
      expect(canonicalize(tstzOf("infinity")), tz).toBe("infinity");
    }
  });

  it("compares timestamptz at microsecond grain", () => {
    const resolver = scopeOf({ a: "timestamptz", b: "timestamptz" });
    const row: Row = {
      a: canonicalize(tstzOf("2024-01-15 02:00:00.000123+00")),
      b: canonicalize(tstzOf("2024-01-15 02:00:00.000456+00"))
    };
    const holds = (p: Expr) => {
      threadExpr(p, resolver);
      return compileRowPredicate(p, [])(row);
    };
    expect(holds(cmp("<", col("a"), col("b")))).toBe(true);
    expect(holds(cmp("=", col("a"), col("b")))).toBe(false);
    expect(holds(cmp("=", col("a"), lit("2024-01-15T02:00:00.000123Z")))).toBe(
      true
    );
    expect(
      holds(cmp(">", col("b"), lit("2024-01-15 02:00:00.000123+00")))
    ).toBe(true);
    expect(
      holds(cmp("=", col("a"), lit("2024-01-15 02:00:00.0001230+00")))
    ).toBe(true);
  });

  it("evaluates date and naive-timestamp bounds TZ-independently", () => {
    const resolver = scopeOf({
      d: "date",
      tsn: "timestamp",
      gap: "timestamp",
      inf: "date"
    });
    for (const tz of TZS) {
      process.env.TZ = tz;
      const row: Row = {
        d: canonicalize(dateOf("2024-01-15")),
        tsn: canonicalize(tsOf("2024-01-15 02:00:00")),
        gap: canonicalize(tsOf("2024-03-10 02:30:00")),
        inf: canonicalize(dateOf("infinity"))
      };
      const holds = (p: Expr) => {
        threadExpr(p, resolver);
        return compileRowPredicate(p, [])(row);
      };
      expect(holds(cmp("=", col("d"), lit("2024-01-15"))), tz).toBe(true);
      expect(holds(cmp(">=", col("tsn"), lit("2024-01-15"))), tz).toBe(true);
      expect(holds(cmp("<", col("gap"), lit("2024-03-10 03:00:00"))), tz).toBe(
        true
      );
      expect(holds(cmp(">", col("inf"), lit("2024-01-15"))), tz).toBe(true);
    }
  });
});

describe.skipIf(!CONN)("time predicates: seed pushdown == JS, per TZ", () => {
  it("agrees on date and naive-timestamp bounds under every TZ", async () => {
    const OPS = ["=", "<>", "<", "<=", ">", ">="] as const;
    for (const tz of TZS) {
      process.env.TZ = tz;
      for (const op of OPS) {
        await agree(cmp(op, col("d"), lit("2024-01-15")), `${tz} d ${op}`);
        await agree(
          cmp(op, col("tsn"), lit("2024-01-15")),
          `${tz} tsn ${op} date-only`
        );
        await agree(
          cmp(op, col("tsn"), lit("2024-01-15 02:00:00")),
          `${tz} tsn ${op} space`
        );
        await agree(
          cmp(op, col("tsn"), lit("2024-03-10 03:00:00")),
          `${tz} tsn ${op} dst-gap`
        );
      }
      await agree(
        cmp("=", col("tsn"), lit("2024-01-15T10:30:00.123456")),
        `${tz} tsn µs T-form`
      );
      await agree(
        {
          kind: "in",
          operand: col("d"),
          list: [lit("2024-01-15"), lit("1969-12-31"), lit(null)],
          negated: false
        },
        `${tz} d in`
      );
      await agree(
        {
          kind: "and",
          items: [
            cmp(">=", col("d"), lit("2024-01-14")),
            cmp("<=", col("d"), lit("2024-06-30"))
          ]
        },
        `${tz} d between`
      );
    }
  }, 30000);
});

describe.skipIf(!CONN)("date keyset pagination: PG == JS, per TZ", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: CONN, max: 2, types: walterTypes });
  });
  afterAll(async () => {
    await pool?.end();
  });

  const key = (column: string, cls: WindowSortKey["cls"]): WindowSortKey => ({
    alias: "x",
    column,
    anchor: true,
    desc: false,
    nullsFirst: false,
    cls
  });
  const ORDER = [key("d", "time"), key("id", "number")];
  const BY_TSTZ = [key("tstz", "time"), key("id", "number")];

  async function walk(
    source: RowSource,
    order: WindowSortKey[]
  ): Promise<number[]> {
    const out: number[] = [];
    let after: readonly unknown[] | undefined;
    for (;;) {
      const { rows } = await source.fetchWindow({
        anchorTable: TABLE,
        anchorAlias: "x",
        order,
        pageSize: 3,
        fetch: {
          from: { kind: "table", name: TABLE, alias: "x" },
          where: undefined
        },
        correlationColumns: [],
        partitions: [{ value: [], after }],
        params: []
      });
      out.push(...rows.map(r => r.id as number));
      if (rows.length < 3) return out;
      after = windowTuple(rows[rows.length - 1]!, order);
    }
  }

  it("pages identically under every TZ (cursor stays on its day)", async () => {
    const pgSrc = new PgRowSource(pool, { defaultSchema: "public" });
    for (const tz of TZS) {
      process.env.TZ = tz;
      const rows = (await pool.query(`SELECT * FROM ${TABLE}`)).rows as Row[];
      const memSrc = new MemRowSource(() => rows);
      const pgIds = await walk(pgSrc, ORDER);
      expect(pgIds, tz).toEqual(await walk(memSrc, ORDER));
      expect(pgIds.length, tz).toBe(SEED.length);
    }
  }, 30000);

  it("pages µs-adjacent timestamptz rows without skips or swaps", async () => {
    const pgSrc = new PgRowSource(pool, { defaultSchema: "public" });
    const rows = (await pool.query(`SELECT * FROM ${TABLE}`)).rows as Row[];
    const memSrc = new MemRowSource(() => rows);
    const pgIds = await walk(pgSrc, BY_TSTZ);
    expect(pgIds).toEqual(await walk(memSrc, BY_TSTZ));
    expect(pgIds.slice(0, 4)).toEqual([3, 1, 2, 11]);
    expect(pgIds.length).toBe(SEED.length);
  }, 30000);
});

describe.skipIf(!CONN)("WAL rows carry canonical time text", () => {
  let cdc: CdcSource;
  const batches: TxnBatch[] = [];

  beforeAll(async () => {
    process.env.TZ = "America/New_York";
    cdc = new CdcSource(CONN!, new SchemaCatalog());
    await cdc.setup();
    await cdc.start(
      batch => {
        batches.push(batch);
      },
      () => {}
    );
  }, 30000);

  afterAll(async () => {
    await cdc?.stop();
  });

  it("decoded insert == seed row == PG's own text", async () => {
    await admin.query(
      `INSERT INTO ${TABLE} VALUES (9, '2024-01-15', '2024-01-15 10:30:00.123456',
        '2024-01-15 10:30:00.123456+00')`
    );
    const walOp = () =>
      batches
        .flatMap(b => b.ops)
        .find(op => op.table === `public.${TABLE}` && op.newRow?.id === 9);
    const deadline = Date.now() + 10_000;
    while (!walOp()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for WAL");
      await new Promise(r => setTimeout(r, 25));
    }
    const wal = walOp()!.newRow!;
    const seed = (await admin.query(`SELECT * FROM ${TABLE} WHERE id = 9`))
      .rows[0] as Row;
    expect(wal).toEqual(seed);
    expect(wal.d).toBe("2024-01-15");
    expect(wal.tsn).toBe("2024-01-15 10:30:00.123456");
    expect(wal.tstz).toBe("2024-01-15 10:30:00.123456+00");
  }, 15000);
});

describe.skipIf(!CONN)("typed time constants (under the session pins)", () => {
  beforeAll(async () => {
    process.env.TZ = "America/New_York";
    await admin.query(SESSION_PINS);
  });
  afterAll(async () => {
    await admin?.query(`SET TIME ZONE DEFAULT`);
  });

  it("truncates instant bounds against a date column (PG's cast rule)", async () => {
    for (const op of ["=", "<>", "<", ">="] as const)
      await agree(
        cmp(op, col("d"), lit("2024-01-15T10:00:00Z")),
        `d ${op} instant`
      );
  });

  it("discards zone suffixes against a naive column (PG's cast rule)", async () => {
    await agree(
      cmp("=", col("tsn"), lit("2024-01-15 02:00:00+05")),
      "tsn = zoned"
    );
    await agree(
      cmp("<", col("tsn"), lit("2024-01-15 02:00:00+05")),
      "tsn < zoned"
    );
  });

  it("agrees at microsecond boundaries against timestamptz", async () => {
    for (const op of ["=", "<>", "<", "<=", ">", ">="] as const) {
      await agree(
        cmp(op, col("tstz"), lit("2024-01-15T02:00:00.000123Z")),
        `tstz ${op} µs`
      );
    }
    await agree(
      cmp("=", col("tstz"), lit("2024-01-15 02:00:00.0001234+00")),
      "tstz = 7-digit round down"
    );
    await agree(
      cmp("=", col("tstz"), lit("2024-01-15 02:00:00.0004565+00")),
      "tstz = 7-digit half (even stays)"
    );
    await agree(
      cmp("=", col("tstz"), lit("2024-01-15 02:00:00.0004555+00")),
      "tstz = 7-digit half (odd rounds up)"
    );
  });

  it("reads zone-less bounds against timestamptz as UTC, session-independently", async () => {
    await agree(cmp(">=", col("tstz"), lit("2024-01-15")), "tstz >= date-only");
    await agree(
      cmp("=", col("tstz"), lit("2024-01-15 02:00:00")),
      "tstz = zone-less"
    );
    await agree(
      cmp("=", col("tstz"), lit("2024-01-15T02:00:00Z")),
      "tstz = zoned"
    );
    await agree(
      {
        kind: "in",
        operand: col("tstz"),
        list: [lit("2024-01-15"), lit("2024-01-15 02:00:00")],
        negated: false
      },
      "tstz in zone-less list"
    );
  });

  it("folds Date params to their UTC form on both evaluators", async () => {
    const param = (): Expr => ({ kind: "param", index: 1 });
    await agree(cmp("=", col("d"), param()), "d = Date param", [
      new Date("2024-01-15T02:00:00Z")
    ]);
    await agree(cmp("=", col("tstz"), param()), "tstz = Date param", [
      new Date("2024-01-15T02:00:00Z")
    ]);
  });

  it("compares date with naive timestamp on the one wall axis", async () => {
    await agree(cmp("=", col("d"), col("tsn")), "d = tsn");
    await agree(
      cmp(
        "=",
        { kind: "coalesce", args: [col("d"), col("tsn")] },
        lit("2024-01-15")
      ),
      "coalesce(d, tsn) promotes to timestamp"
    );
  });

  it("rejects cross-axis column comparisons at planning", () => {
    for (const pred of [
      cmp("=", col("d"), col("tstz")),
      cmp("<", col("tsn"), col("tstz")),
      cmp("=", { kind: "coalesce", args: [col("tsn"), col("tstz")] }, lit("x"))
    ]) {
      expect(() => threadExpr(pred, RESOLVER)).toThrow(UnsupportedSqlError);
    }
  });
});
