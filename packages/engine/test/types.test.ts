import { describe, it, expect } from "vitest";
import { parseSql } from "../src/parser/parse";
import { expandStars } from "../src/parser/expand";
import {
  compareClassValues,
  roundHalfAwayFromZero,
  roundHalfEven
} from "../src/parser/eval";
import { compileRowExpr, compileRowPredicate } from "../src/planner/compile";
import { foldArrayParams } from "../src/planner/plan";
import { exprEquals } from "../src/planner/exprutil";
import { PlanScope } from "../src/planner/scope";
import { threadExpr, threadQueryTypes } from "../src/planner/types";
import { exprToSql } from "../src/lazy/pg-source";
import {
  SqlEvalError,
  UnsupportedSqlError,
  type Expr,
  type PgClass,
  type Query
} from "../src/parser/ir";
import type { Row } from "../src/ivm/zset";
import { catalogOf } from "./support";

const evalExpr = (e: Expr, row: Row, params: unknown[]): unknown =>
  compileRowExpr(e, params)(row);

const toSql = (e: Expr, params: unknown[] = ["p"]): string => {
  const values: unknown[] = [];
  return exprToSql(e, params, v => `$${values.push(v)}`);
};

const TYPES: Record<string, Record<string, string>> = {
  item: {
    id: "int4",
    a: "int4",
    b: "int4",
    score: "int4",
    big: "int8",
    ratio: "float8",
    f4: "float4",
    sm: "int2",
    price: "numeric",
    name: "text",
    ok: "bool",
    at: "timestamptz",
    day: "date",
    naive: "timestamp",
    u: "uuid",
    bin: "bytea",
    meta: "jsonb"
  }
};

const CATALOG = catalogOf({ columnTypes: TYPES });
const resolve = new PlanScope([{ name: "item", alias: "item" }], CATALOG)
  .classOf;

const bind = (q: Query): void => {
  expandStars(q, CATALOG);
  threadQueryTypes(q, resolve);
};

async function whereOf(sql: string): Promise<Expr> {
  const q = await parseSql(sql);
  bind(q);
  compileRowExpr(q.where!, []);
  return q.where!;
}

describe("type threading", () => {
  it("threads column, literal and arithmetic classes from the catalog", async () => {
    const w = await whereOf(
      "SELECT id FROM item WHERE score + 1 > price * 2.5"
    );
    expect(w.kind).toBe("binary");
    const cmp = w as Extract<Expr, { kind: "binary" }>;
    expect(cmp.left.ptype).toBe("int");
    expect(cmp.right.ptype).toBe("numeric");
  });

  it("integer division truncates toward zero, like Postgres", async () => {
    const w = await whereOf("SELECT id FROM item WHERE score / 2 = 3");
    const div = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(div.ptype).toBe("int");
    expect(evalExpr(div, { score: 7 }, [])).toBe(3);
    expect(evalExpr(div, { score: -7 }, [])).toBe(-3); // trunc, not floor
  });

  it("rejects / and % on numeric operands at planning", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE score / 2.0 = 3.5")
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      whereOf("SELECT id FROM item WHERE price % 2 = 1")
    ).rejects.toThrow(UnsupportedSqlError);
    const w = await whereOf("SELECT id FROM item WHERE ratio / 2 = 3.5");
    const div = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(div.ptype).toBe("float");
    expect(evalExpr(div, { ratio: 7 }, [])).toBe(3.5);
  });

  it("numeric arithmetic is exact and renders PG's canonical text", async () => {
    const w = await whereOf("SELECT id FROM item WHERE price + 0.1 = 0.3");
    const add = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(add.ptype).toBe("numeric");
    expect(evalExpr(add, { price: "0.2" }, [])).toBe("0.3");
    const w2 = await whereOf("SELECT id FROM item WHERE price + 1.50 = 0");
    const add2 = (w2 as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(add2, { price: "2" }, [])).toBe("3.50");
    const w3 = await whereOf("SELECT id FROM item WHERE price * 1.5 = 0");
    const mul = (w3 as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(mul, { price: "2.0" }, [])).toBe("3.00");
    const w4 = await whereOf("SELECT id FROM item WHERE price + 1 = 0");
    const add4 = (w4 as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(add4, { price: "12345678901234567890.12" }, [])).toBe(
      "12345678901234567891.12"
    );
  });

  it("::int rounds by source type: numeric half-away, float half-even", async () => {
    const wNum = await whereOf("SELECT id FROM item WHERE price::int = 3");
    const castNum = (wNum as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(castNum, { price: 2.5 }, [])).toBe(3);
    expect(evalExpr(castNum, { price: -2.5 }, [])).toBe(-3);

    const wFlt = await whereOf("SELECT id FROM item WHERE ratio::int = 2");
    const castFlt = (wFlt as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(castFlt, { ratio: 2.5 }, [])).toBe(2);
    expect(evalExpr(castFlt, { ratio: 3.5 }, [])).toBe(4);
    expect(evalExpr(castFlt, { ratio: -2.5 }, [])).toBe(-2);
    expect(evalExpr(castFlt, { ratio: -3.5 }, [])).toBe(-4);
  });

  it("int8 (bigint) arithmetic is exact past float64's safe range", async () => {
    const w = await whereOf("SELECT id FROM item WHERE big + 1 > 0");
    const add = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(add.ptype).toBe("int8");
    expect(evalExpr(add, { big: "9223372036854775806" }, [])).toBe(
      "9223372036854775807"
    );
    const w2 = await whereOf("SELECT id FROM item WHERE big * big > 0");
    const mul = (w2 as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(mul, { big: "3037000499" }, [])).toBe(
      "9223372030926249001"
    );
    expect(() => evalExpr(mul, { big: "3037000500" }, [])).toThrow(
      /bigint out of range/
    );
    const w3 = await whereOf("SELECT id FROM item WHERE score + big > 0");
    expect((w3 as Extract<Expr, { kind: "binary" }>).left.ptype).toBe("int8");
  });

  it("int8 division truncates toward zero, modulo takes the dividend sign", async () => {
    const wd = await whereOf("SELECT id FROM item WHERE big / 2 = 0");
    const div = (wd as Extract<Expr, { kind: "binary" }>).left;
    expect(div.ptype).toBe("int8");
    expect(evalExpr(div, { big: "9223372036854775807" }, [])).toBe(
      "4611686018427387903"
    );
    expect(evalExpr(div, { big: "-7" }, [])).toBe("-3"); // trunc, not floor
    const wm = await whereOf("SELECT id FROM item WHERE big % 3 = 0");
    const mod = (wm as Extract<Expr, { kind: "binary" }>).left;
    expect(evalExpr(mod, { big: "-7" }, [])).toBe("-1");
  });

  it("::bigint casts exactly to integer text", async () => {
    const w = await whereOf("SELECT id FROM item WHERE price::bigint = 0");
    const cast = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(cast.ptype).toBe("int8");
    expect(evalExpr(cast, { price: "1234567890123456789.5" }, [])).toBe(
      "1234567890123456790"
    );
    expect(() =>
      evalExpr(cast, { price: "12345678901234567890.5" }, [])
    ).toThrow(/bigint out of range/);
  });

  it("rejects avg over exact numeric types (numeric/int/bigint)", async () => {
    for (const col of ["price", "score", "big"]) {
      await expect(
        whereOf(`SELECT avg(${col}) AS a FROM item WHERE id > 0`)
      ).rejects.toThrow(UnsupportedSqlError);
    }
    await expect(
      whereOf("SELECT avg(big::float8) AS a FROM item WHERE id > 0")
    ).resolves.toBeDefined();
  });

  it("rejects sum over real (single-precision accumulation is plan-defined)", async () => {
    for (const agg of ["sum(f4)", "sum(DISTINCT f4)", "sum(f4 + f4)"]) {
      await expect(
        whereOf(`SELECT ${agg} AS s FROM item WHERE id > 0`)
      ).rejects.toThrow(/sum over real/);
    }
    await expect(
      whereOf("SELECT sum(f4::float8) AS s FROM item WHERE id > 0")
    ).resolves.toBeDefined();
    await expect(
      whereOf("SELECT avg(f4) AS a FROM item WHERE id > 0")
    ).resolves.toBeDefined();
  });

  it("bare params in / and % take the sibling's class (PG resolution)", async () => {
    const w = await whereOf("SELECT id FROM item WHERE score / $1 > 2");
    const div = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(div.ptype).toBe("int");
    expect((div as Extract<Expr, { kind: "binary" }>).right.ptype).toBe("int");
    await expect(
      whereOf("SELECT id FROM item WHERE $1 / $2 > 2")
    ).rejects.toThrow(/operator is not unique/);
  });

  it("rejects ::int of text/unknown operands at planning", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE name::int = 1")
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      whereOf("SELECT id FROM item WHERE $1::int = 1")
    ).resolves.toBeDefined();
  });

  it('emits COLLATE "C" on pushed-down ordered text comparisons', async () => {
    const w = await whereOf("SELECT id FROM item WHERE name > $1");
    expect(toSql(w)).toBe('("name" COLLATE "C" > $1)');
    const w2 = await whereOf("SELECT id FROM item WHERE $1 <= name");
    expect(toSql(w2)).toBe('($1 COLLATE "C" <= "name")');
    const w3 = await whereOf("SELECT id FROM item WHERE name = $1");
    expect(toSql(w3)).toBe('("name" = $1)');
  });

  it("compares uuid columns bytewise, like Postgres", async () => {
    const lo = "0f000000-0000-0000-0000-000000000000";
    const hi = "10000000-0000-0000-0000-000000000000";
    const lt = () => whereOf("SELECT id FROM item WHERE u < $1");
    expect(evalExpr(await lt(), { u: lo }, [hi])).toBe(true);
    expect(evalExpr(await lt(), { u: hi }, [lo])).toBe(false);
    expect(toSql(await lt())).toBe('("u" < $1)');
  });

  it("rejects comparisons on types Walter cannot classify (jsonb)", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE meta = $1")
    ).rejects.toThrow(UnsupportedSqlError);
  });

  it("rejects cross-class comparisons that error in Postgres", async () => {
    for (const pred of [
      "name = id",
      "ok < id",
      "at > name",
      "u = name",
      "name IN (1, 2)"
    ])
      await expect(
        whereOf(`SELECT id FROM item WHERE ${pred}`)
      ).rejects.toThrow(UnsupportedSqlError);
    for (const pred of ["id = price", "big < ratio", "score >= 1.5"])
      await expect(
        whereOf(`SELECT id FROM item WHERE ${pred}`)
      ).resolves.toBeDefined();
  });

  it("compares time chronologically, not textually", async () => {
    const eq = await whereOf("SELECT id FROM item WHERE at = $1");
    expect(
      evalExpr(eq, { at: "2020-01-01 00:00:00+00" }, ["2020-01-01T00:00:00Z"])
    ).toBe(true);
    const gt = await whereOf("SELECT id FROM item WHERE at > $1");
    expect(
      evalExpr(gt, { at: "2020-06-15 12:30:00.123+00" }, [
        "2020-06-15T12:30:00Z"
      ])
    ).toBe(true);
    expect(evalExpr(gt, { at: null }, ["2020-06-15T12:30:00Z"])).toBe(null);
  });

  it("rejects non-ISO time bounds at planning, with a clear message", async () => {
    const w = await whereOf("SELECT id FROM item WHERE at > $1");
    expect(() => evalExpr(w, { at: null }, ["last tuesday"])).toThrow(
      /ISO 8601/
    );
    expect(() => evalExpr(w, { at: null }, [123])).toThrow(UnsupportedSqlError);
    await expect(
      whereOf("SELECT id FROM item WHERE at > 'Thu Jan 01 1970'")
    ).rejects.toThrow(/ISO 8601/);
  });

  it("does not collate a string literal coerced to a time column", async () => {
    const w = await whereOf("SELECT id FROM item WHERE at > '2024-01-15'");
    expect(toSql(w)).toBe(`("at" > '2024-01-15')`);
  });

  it("threadExpr takes qualified refs only; expand.ts resolves bare ones", () => {
    const two = new PlanScope(
      [
        { name: "a", alias: "a" },
        { name: "b", alias: "b" }
      ],
      catalogOf({ columnTypes: { a: { x: "int4" }, b: { x: "text" } } })
    ).classOf;
    const e: Expr = { kind: "column", name: "x" };
    expect(() => threadExpr(e, two)).toThrow(/column "x" does not exist/);
    const q: Expr = { kind: "column", table: "a", name: "x" };
    expect(threadExpr(q, two)).toBe("int" satisfies PgClass);
  });
});

describe("LIKE/ILIKE matching", () => {
  it("constant patterns: wildcards, ASCII-only ILIKE folding, NULL", async () => {
    const w = await whereOf("SELECT id FROM item WHERE name LIKE 'a%'");
    expect(evalExpr(w, { name: "ab" }, [])).toBe(true);
    expect(evalExpr(w, { name: "b" }, [])).toBe(false);
    expect(evalExpr(w, { name: null }, [])).toBe(null);
    const i = await whereOf("SELECT id FROM item WHERE name ILIKE 'A_'");
    expect(evalExpr(i, { name: "ab" }, [])).toBe(true);
    expect(evalExpr(i, { name: "Äb" }, [])).toBe(false);
  });

  it("a NULL param pattern yields NULL", async () => {
    const w = await whereOf("SELECT id FROM item WHERE name LIKE $1");
    expect(evalExpr(w, { name: "ab" }, [null])).toBe(null);
  });

  it("column-derived patterns evaluate per row", async () => {
    const w = await whereOf("SELECT id FROM item WHERE name LIKE upper(name)");
    expect(evalExpr(w, { name: "A" }, [])).toBe(true);
    expect(evalExpr(w, { name: "a" }, [])).toBe(false);
    expect(evalExpr(w, { name: null }, [])).toBe(null);
  });
});

describe("boolean tests (IS [NOT] TRUE/FALSE/UNKNOWN)", () => {
  const states: { label: string; row: Row }[] = [
    { label: "true", row: { ok: true } },
    { label: "false", row: { ok: false } },
    { label: "null", row: { ok: null } }
  ];

  const cases: [string, Set<string>][] = [
    ["ok IS TRUE", new Set(["true"])],
    ["ok IS NOT TRUE", new Set(["false", "null"])],
    ["ok IS FALSE", new Set(["false"])],
    ["ok IS NOT FALSE", new Set(["true", "null"])],
    ["ok IS UNKNOWN", new Set(["null"])],
    ["ok IS NOT UNKNOWN", new Set(["true", "false"])]
  ];

  for (const [pred, accepted] of cases) {
    it(`${pred} is a total predicate over true/false/null`, async () => {
      const w = await whereOf(`SELECT id FROM item WHERE ${pred}`);
      for (const { label, row } of states) {
        const v = evalExpr(w, row, []);
        expect(typeof v, `${pred} on ${label} must be a definite boolean`).toBe(
          "boolean"
        );
        expect(v, `${pred} on ${label}`).toBe(accepted.has(label));
      }
      expect(() => toSql(w)).not.toThrow();
    });
  }

  it("IS UNKNOWN desugars to the IS NULL node", async () => {
    const w = await whereOf("SELECT id FROM item WHERE ok IS UNKNOWN");
    expect(w).toEqual({
      kind: "isNull",
      ptype: "bool",
      operand: { kind: "column", table: "item", name: "ok", ptype: "bool" },
      negated: false
    });
  });
});

describe("null-safe equality (IS [NOT] DISTINCT FROM)", () => {
  const pairs: { label: string; row: Row }[] = [
    { label: "equal", row: { a: 1, b: 1 } },
    { label: "unequal", row: { a: 1, b: 2 } },
    { label: "left-null", row: { a: null, b: 1 } },
    { label: "right-null", row: { a: 1, b: null } },
    { label: "both-null", row: { a: null, b: null } }
  ];

  const cases: [string, Set<string>][] = [
    ["a IS DISTINCT FROM b", new Set(["unequal", "left-null", "right-null"])],
    ["a IS NOT DISTINCT FROM b", new Set(["equal", "both-null"])]
  ];

  for (const [pred, accepted] of cases) {
    it(`${pred} is a total predicate over null operands`, async () => {
      const w = await whereOf(`SELECT id FROM item WHERE ${pred}`);
      for (const { label, row } of pairs) {
        const v = evalExpr(w, row, []);
        expect(typeof v, `${pred} on ${label} must be a definite boolean`).toBe(
          "boolean"
        );
        expect(v, `${pred} on ${label}`).toBe(accepted.has(label));
      }
      expect(() => toSql(w)).not.toThrow();
    });
  }
});

describe("BETWEEN SYMMETRIC", () => {
  const rows: { label: string; row: Row }[] = [
    { label: "in", row: { score: 5 } },
    { label: "low-edge", row: { score: 3 } },
    { label: "high-edge", row: { score: 7 } },
    { label: "out", row: { score: 9 } }
  ];

  const cases: [string, Set<string>][] = [
    [
      "score BETWEEN SYMMETRIC 7 AND 3",
      new Set(["in", "low-edge", "high-edge"])
    ],
    ["score NOT BETWEEN SYMMETRIC 7 AND 3", new Set(["out"])]
  ];

  for (const [pred, accepted] of cases) {
    it(`${pred} accepts swapped bounds`, async () => {
      const w = await whereOf(`SELECT id FROM item WHERE ${pred}`);
      for (const { label, row } of rows) {
        expect(evalExpr(w, row, []), `${pred} on ${label}`).toBe(
          accepted.has(label)
        );
      }
      expect(() => toSql(w)).not.toThrow();
    });
  }
});

describe("= ANY / <> ALL over array literals", () => {
  const equivalents: [string, string][] = [
    ["score = ANY (ARRAY[1, 2, 3])", "score IN (1, 2, 3)"],
    ["score <> ALL (ARRAY[1, 2, 3])", "score NOT IN (1, 2, 3)"]
  ];

  for (const [quantified, inForm] of equivalents) {
    it(`${quantified} is exactly \`${inForm}\``, async () => {
      const a = await whereOf(`SELECT id FROM item WHERE ${quantified}`);
      const b = await whereOf(`SELECT id FROM item WHERE ${inForm}`);
      expect(a).toEqual(b);
    });
  }

  it("rejects quantifier forms that are not IN/NOT IN", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE score < ANY (ARRAY[1, 2])")
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      whereOf("SELECT id FROM item WHERE score = ALL (ARRAY[1, 2])")
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      whereOfFolded("SELECT id FROM item WHERE score < ANY ($1)", [[1, 2]])
    ).rejects.toThrow(UnsupportedSqlError);
  });
});

async function whereOfFolded(sql: string, params: unknown[]): Promise<Expr> {
  const q = await parseSql(sql);
  foldArrayParams({ query: q, collections: [] }, params);
  bind(q);
  return q.where!;
}

describe("= ANY / <> ALL over array params", () => {
  it("= ANY($1) folds to IN over the elements' text forms (array_in's model)", async () => {
    const a = await whereOfFolded(
      "SELECT id FROM item WHERE score = ANY ($1)",
      [[1, 2, 3]]
    );
    expect(a.kind).toBe("in");
    expect(evalExpr(a, { score: 2 }, [])).toBe(true);
    expect(evalExpr(a, { score: 4 }, [])).toBe(false);
    expect(toSql(a)).toBe(`("score" IN ('1', '2', '3'))`);
    const n = await whereOfFolded(
      "SELECT id FROM item WHERE score <> ALL ($1)",
      [[1, 2, 3]]
    );
    expect(evalExpr(n, { score: 2 }, [])).toBe(false);
    expect(evalExpr(n, { score: 4 }, [])).toBe(true);
    const a2 = await whereOfFolded(
      "SELECT id FROM item WHERE score = ANY ($1)",
      [[1, 2, 3]]
    );
    expect(exprEquals(a, a2)).toBe(true);
  });

  it("elements coerce by the operand column's input function", async () => {
    const u = await whereOfFolded("SELECT id FROM item WHERE u = ANY ($1)", [
      ["123E4567-E89B-12D3-A456-426614174000"]
    ]);
    expect(evalExpr(u, { u: "123e4567-e89b-12d3-a456-426614174000" }, [])).toBe(
      true
    );
    expect(toSql(u)).toContain("'123E4567-E89B-12D3-A456-426614174000'");

    const t = await whereOfFolded("SELECT id FROM item WHERE at = ANY ($1)", [
      ["2024-01-15T10:00:00"]
    ]);
    expect(evalExpr(t, { at: "2024-01-15T10:00:00.000Z" }, [])).toBe(true);

    const d = await whereOfFolded("SELECT id FROM item WHERE at = ANY ($1)", [
      [new Date("2024-01-15T10:00:00Z")]
    ]);
    expect(evalExpr(d, { at: "2024-01-15T10:00:00.000Z" }, [])).toBe(true);

    const b = await whereOfFolded("SELECT id FROM item WHERE ok = ANY ($1)", [
      ["f"]
    ]);
    expect(evalExpr(b, { ok: false }, [])).toBe(true);
    expect(evalExpr(b, { ok: true }, [])).toBe(false);

    const i = await whereOfFolded(
      "SELECT id FROM item WHERE score = ANY ($1)",
      [[" 5 ", "6"]]
    );
    expect(evalExpr(i, { score: 5 }, [])).toBe(true);
    expect(evalExpr(i, { score: 7 }, [])).toBe(false);
  });

  it("number/bool elements against a text column take their text form", async () => {
    const w = await whereOfFolded("SELECT id FROM item WHERE name = ANY ($1)", [
      [42, true]
    ]);
    expect(evalExpr(w, { name: "42" }, [])).toBe(true);
    expect(evalExpr(w, { name: "true" }, [])).toBe(true);
    expect(evalExpr(w, { name: "42.0" }, [])).toBe(false);
    expect(toSql(w)).toBe(`("name" IN ('42', 'true'))`);
  });

  it("rejects elements the column's input function rejects (at compile, like every bound)", async () => {
    const cases: [string, unknown[]][] = [
      ["score = ANY ($1)", [[2.5]]], // int4in rejects fractions
      ["score = ANY ($1)", [[true]]], // int4in('true') is an error
      ["big = ANY ($1)", [[1.5]]] // int8in likewise
    ];
    for (const [where, params] of cases) {
      const w = await whereOfFolded(
        `SELECT id FROM item WHERE ${where}`,
        params
      );
      expect(() => evalExpr(w, { score: 1, big: 1, ratio: 1 }, [])).toThrow(
        UnsupportedSqlError
      );
    }
    const scalar = await whereOf("SELECT id FROM item WHERE score = $1");
    expect(() => evalExpr(scalar, { score: 1 }, [true])).toThrow(
      UnsupportedSqlError
    );
  });

  it("rejects non-array params and non-scalar elements at the fold", async () => {
    await expect(
      whereOfFolded("SELECT id FROM item WHERE score = ANY ($1)", [42])
    ).rejects.toThrow(/must be an array/);
    await expect(
      whereOfFolded("SELECT id FROM item WHERE score = ANY ($1)", [[[1, 2]]])
    ).rejects.toThrow(/scalar elements/);
  });

  it("empty array: zero-element ScalarArrayOp, operand not examined", async () => {
    const any = await whereOfFolded(
      "SELECT id FROM item WHERE score = ANY ($1)",
      [[]]
    );
    expect(evalExpr(any, { score: 1 }, [])).toBe(false);
    expect(evalExpr(any, { score: null }, [])).toBe(false);
    expect(toSql(any)).toBe("FALSE");
    const all = await whereOfFolded(
      "SELECT id FROM item WHERE score <> ALL ($1)",
      [[]]
    );
    expect(evalExpr(all, { score: null }, [])).toBe(true);
    expect(toSql(all)).toBe("TRUE");
  });

  it("NULL (or missing) array param is NULL for every operand", async () => {
    for (const params of [[null], []]) {
      const any = await whereOfFolded(
        "SELECT id FROM item WHERE score = ANY ($1)",
        params
      );
      expect(evalExpr(any, { score: 1 }, [])).toBe(null);
      const all = await whereOfFolded(
        "SELECT id FROM item WHERE score <> ALL ($1)",
        params
      );
      expect(evalExpr(all, { score: 1 }, [])).toBe(null);
    }
  });

  it("a NULL element keeps IN's three-valued semantics", async () => {
    const w = await whereOfFolded(
      "SELECT id FROM item WHERE score = ANY ($1)",
      [[1, null]]
    );
    expect(evalExpr(w, { score: 1 }, [])).toBe(true);
    expect(evalExpr(w, { score: 2 }, [])).toBe(null);
  });

  it("still validates the operand when the array is empty", async () => {
    await expect(
      whereOfFolded("SELECT id FROM item WHERE bogus = ANY ($1)", [[]])
    ).rejects.toThrow();
  });

  it("= ANY(ARRAY[$1, $2]) keeps its scalar-param path", async () => {
    const w = await whereOfFolded(
      "SELECT id FROM item WHERE score = ANY (ARRAY[$1, $2])",
      [1, 2]
    );
    expect(evalExpr(w, { score: 2 }, [1, 2])).toBe(true);
  });

  it("an unfolded anyParam cannot reach planning", async () => {
    const q = await parseSql("SELECT id FROM item WHERE score = ANY ($1)");
    expect(() => bind(q)).toThrow(/folded before planning/);
  });
});

describe("division by zero raises like Postgres", () => {
  it("raises on / and % across int, int8 and float paths", async () => {
    const div = await whereOf("SELECT id FROM item WHERE score / $1::int = 2");
    expect(evalExpr(div, { score: 5 }, [2])).toBe(true);
    expect(() => evalExpr(div, { score: 5 }, [0])).toThrow(SqlEvalError);
    const mod = await whereOf("SELECT id FROM item WHERE score % 0 = 1");
    expect(() => evalExpr(mod, { score: 5 }, [])).toThrow(SqlEvalError);
    const big = await whereOf("SELECT id FROM item WHERE big / 0 = 1");
    expect(() => evalExpr(big, { big: "5" }, [])).toThrow(SqlEvalError);
    const fl = await whereOf("SELECT id FROM item WHERE ratio / 0 = 1");
    expect(() => evalExpr(fl, { ratio: 1.5 }, [])).toThrow(SqlEvalError);
  });

  it("stays NULL-strict: a NULL operand never raises", async () => {
    const div = await whereOf("SELECT id FROM item WHERE score / 0 = 1");
    expect(evalExpr(div, { score: null }, [])).toBe(null);
  });
});

describe("numeric spellings canonicalize where typed", () => {
  it("literals collapse to canonical text at parse", async () => {
    const w = await whereOf("SELECT id FROM item WHERE price = 1.500e1");
    expect((w as { right?: Expr }).right).toMatchObject({
      kind: "literal",
      value: "15.00",
      ptype: "numeric"
    });
  });

  it("exponent bounds compare exactly, both directions", async () => {
    const eq = await whereOf("SELECT id FROM item WHERE price = 1e2");
    expect(evalExpr(eq, { price: "100" }, [])).toBe(true);
    const gt = await whereOf("SELECT id FROM item WHERE price > 1e1");
    expect(evalExpr(gt, { price: "100" }, [])).toBe(true);
    expect(evalExpr(gt, { price: "5" }, [])).toBe(false);
  });

  it("bare-dot bounds are exact, not float-approximate", async () => {
    const w = await whereOf("SELECT id FROM item WHERE price = .1");
    expect(evalExpr(w, { price: "0.1" }, [])).toBe(true);
    expect(evalExpr(w, { price: "0.10000000000000000001" }, [])).toBe(false);
  });

  it("arithmetic over exponent literals and params stays exact", async () => {
    const lit = await whereOf("SELECT id FROM item WHERE price + 1e-1 = 0.3");
    expect(evalExpr(lit, { price: "0.2" }, [])).toBe(true);
    const par = await whereOf("SELECT id FROM item WHERE price + $1 = 0.3");
    expect(evalExpr(par, { price: "0.2" }, ["1e-1"])).toBe(true);
  });

  it("underscore and radix literals evaluate and render canonically", async () => {
    const under = await whereOf("SELECT id FROM item WHERE price = 1_000.5");
    expect(evalExpr(under, { price: "1000.5" }, [])).toBe(true);
    expect(toSql(under, [])).toBe('("price" = 1000.5)');
    const hex = await whereOf("SELECT id FROM item WHERE big = 0x1_0000_0000");
    expect(evalExpr(hex, { big: "4294967296" }, [])).toBe(true);
  });

  it("string params canonicalize at their numeric occurrence", async () => {
    const exp = await whereOf("SELECT id FROM item WHERE price = $1");
    expect(evalExpr(exp, { price: "100" }, ["1e2"])).toBe(true);
    const plus = await whereOf("SELECT id FROM item WHERE price = $1");
    expect(evalExpr(plus, { price: "100" }, ["+100"])).toBe(true);
  });

  it("refuses what the target's input function refuses", async () => {
    const int = await whereOf("SELECT id FROM item WHERE score = $1");
    expect(() => evalExpr(int, { score: 100 }, ["1e2"])).toThrow(
      UnsupportedSqlError
    );
    const nan = await whereOf("SELECT id FROM item WHERE price = $1");
    expect(evalExpr(nan, { price: "1" }, ["NaN"])).toBe(false);
    expect(evalExpr(nan, { price: "NaN" }, ["NaN"])).toBe(true);
    const inf = await whereOf("SELECT id FROM item WHERE price > $1");
    expect(evalExpr(inf, { price: "Infinity" }, ["1e30"])).toBe(true);
    expect(evalExpr(inf, { price: "-Infinity" }, ["-1e30"])).toBe(false);
  });

  it("refuses overflow spellings at parse, like PG", async () => {
    await expect(
      parseSql("SELECT id FROM item WHERE price = 1e131072")
    ).rejects.toThrow(UnsupportedSqlError);
  });
});

describe("unary plus", () => {
  it("collapses to its operand", async () => {
    const plus = await whereOf("SELECT id FROM item WHERE +score = 5");
    const plain = await whereOf("SELECT id FROM item WHERE score = 5");
    expect(plus).toEqual(plain);
  });
});

describe("rounding helpers (PG-exact)", () => {
  it("half-even (float -> int)", () => {
    const cases: [number, number][] = [
      [0.5, 0],
      [1.5, 2],
      [2.5, 2],
      [3.5, 4],
      [-0.5, 0],
      [-1.5, -2],
      [-2.5, -2],
      [-3.5, -4],
      [2.4, 2],
      [2.6, 3],
      [-2.6, -3]
    ];
    for (const [n, want] of cases)
      expect(roundHalfEven(n), `n=${n}`).toBe(want);
  });

  it("half away from zero (numeric -> int)", () => {
    const cases: [number, number][] = [
      [0.5, 1],
      [1.5, 2],
      [2.5, 3],
      [-0.5, -1],
      [-2.5, -3],
      [2.4, 2],
      [-2.4, -2]
    ];
    for (const [n, want] of cases)
      expect(roundHalfAwayFromZero(n), `n=${n}`).toBe(want);
  });
});

describe("constants coerce onto the compared column's type", () => {
  const CANON = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const UPPER = CANON.toUpperCase();

  const fresh = async (sql: string, row: Row, params: unknown[] = []) =>
    evalExpr(await whereOf(sql), row, params);

  it("matches uuid constants case-insensitively, like uuid_in", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE u = $1", { u: CANON }, [UPPER])
    ).toBe(true);
    expect(
      await fresh(`SELECT id FROM item WHERE u = '${UPPER}'`, { u: CANON })
    ).toBe(true);
    expect(
      await fresh("SELECT id FROM item WHERE u <> $1", { u: CANON }, [UPPER])
    ).toBe(false);
  });

  it("accepts uuid_in's alternative spellings (braces, omitted hyphens)", async () => {
    for (const s of [
      `{${CANON}}`,
      CANON.replace(/-/g, ""),
      `{${UPPER.replace(/-/g, "")}}`,
      "a0eebc99-9c0b4ef8-bb6d-6bb9bd380a11" // hyphens at only some 4-digit boundaries
    ]) {
      expect(
        await fresh("SELECT id FROM item WHERE u = $1", { u: CANON }, [s]),
        s
      ).toBe(true);
    }
  });

  it("orders uuid bounds bytewise after normalization", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE u < $1", { u: CANON }, [
        "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A12"
      ])
    ).toBe(true);
  });

  it("normalizes every member of a uuid IN list", async () => {
    expect(
      await fresh(
        `SELECT id FROM item WHERE u IN ('${UPPER}', '{a0eebc999c0b4ef8bb6d6bb9bd380a12}')`,
        { u: CANON }
      )
    ).toBe(true);
  });

  it("$1::uuid declares the param's type, like $1::int", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE u = $1::uuid", { u: CANON }, [
        UPPER
      ])
    ).toBe(true);
  });

  it("rejects text uuid_in rejects, at planning", async () => {
    for (const bad of [
      "not-a-uuid",
      "",
      `{${CANON}`, // unmatched braces
      `${CANON}}`,
      CANON.slice(0, -1), // 31 digits
      `${CANON}0`,
      "a0e-ebc99-9c0b-4ef8-bb6d6bb9bd380a11", // hyphen off the 4-digit boundary
      "a0eebc99--9c0b-4ef8-bb6d-6bb9bd380a11",
      ` ${CANON}` // uuid_in does not trim
    ]) {
      const w = await whereOf("SELECT id FROM item WHERE u = $1");
      expect(
        () => evalExpr(w, { u: CANON }, [bad]),
        JSON.stringify(bad)
      ).toThrow(UnsupportedSqlError);
    }
  });

  it("rejects ::uuid over non-constant, non-uuid operands", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE name::uuid = u")
    ).rejects.toThrow(UnsupportedSqlError);
  });

  it("$1::timestamptz/::timestamp/::date declare the param's type", async () => {
    expect(
      await fresh(
        "SELECT id FROM item WHERE at = $1::timestamptz",
        { at: "2024-01-15 02:00:00.000123+00" },
        ["2024-01-15T02:00:00.000123Z"]
      )
    ).toBe(true);
    expect(
      await fresh(
        "SELECT id FROM item WHERE day = $1::date",
        { day: "2024-01-15" },
        ["2024-01-15T10:00:00Z"]
      )
    ).toBe(true);
    expect(
      await fresh(
        "SELECT id FROM item WHERE naive = $1::timestamp",
        { naive: "2024-01-15 02:00:00" },
        ["2024-01-15 02:00:00+05"]
      )
    ).toBe(true);
  });

  it("zone-less cast literals read as UTC (the one bound convention)", async () => {
    expect(
      await fresh(
        "SELECT id FROM item WHERE at = '2024-01-15 02:00:00'::timestamptz",
        {
          at: "2024-01-15 02:00:00+00"
        }
      )
    ).toBe(true);
  });

  it("normalizes time casts in projection position", async () => {
    const q = await parseSql("SELECT $1::date AS x FROM item");
    bind(q);
    expect(evalExpr(q.select[0]!.expr, {}, ["2024-01-15T10:00:00Z"])).toBe(
      "2024-01-15"
    );
    const q2 = await parseSql("SELECT $1::timestamptz AS x FROM item");
    bind(q2);
    expect(evalExpr(q2.select[0]!.expr, {}, ["2024-01-15 02:00:00"])).toBe(
      "2024-01-15 02:00:00Z"
    );
  });

  it("rejects time text timestamptz_in rejects, at planning", async () => {
    const q = await parseSql("SELECT id FROM item WHERE at = $1::timestamptz");
    bind(q);
    expect(() => compileRowExpr(q.where!, ["bogus"])).toThrow(
      UnsupportedSqlError
    );
  });

  it("rejects time casts over non-constant, non-identity operands", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE name::timestamptz = at")
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      whereOf("SELECT id FROM item WHERE naive::timestamptz = at")
    ).rejects.toThrow(UnsupportedSqlError);
    const idCast = await whereOf(
      "SELECT id FROM item WHERE at::timestamptz = $1"
    );
    expect(toSql(idCast, ["2024-01-15T02:00:00Z"])).toContain("::timestamptz");
  });

  it("still rejects cross-axis comparison against a declared param", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE naive > $1::timestamptz")
    ).rejects.toThrow(UnsupportedSqlError);
  });

  it("reads bool text per bool_in ('f' must match false, not true)", async () => {
    const trues = ["t", "tr", "true", "TRUE", "y", "yes", "on", "1", " t "];
    const falses = ["f", "fal", "false", "FALSE", "n", "no", "of", "off", "0"];
    for (const s of trues) {
      expect(
        await fresh(`SELECT id FROM item WHERE ok = '${s}'`, { ok: true }),
        s
      ).toBe(true);
      expect(
        await fresh(`SELECT id FROM item WHERE ok = '${s}'`, { ok: false }),
        s
      ).toBe(false);
    }
    for (const s of falses) {
      expect(
        await fresh(`SELECT id FROM item WHERE ok = '${s}'`, { ok: false }),
        s
      ).toBe(true);
      expect(
        await fresh(`SELECT id FROM item WHERE ok = '${s}'`, { ok: true }),
        s
      ).toBe(false);
    }
  });

  it("bool params accept strings and 0/1 numbers (the driver's text forms)", async () => {
    const eq = "SELECT id FROM item WHERE ok = $1";
    expect(await fresh(eq, { ok: false }, ["f"])).toBe(true);
    expect(await fresh(eq, { ok: true }, [1])).toBe(true);
    expect(await fresh(eq, { ok: false }, [0])).toBe(true);
    expect(await fresh(eq, { ok: true }, [1n])).toBe(true);
  });

  it("a bool-string param IN a boolean list coerces like PG", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE $1 IN (true)", {}, ["f"])
    ).toBe(false);
    expect(
      await fresh("SELECT id FROM item WHERE $1 IN (false)", {}, ["f"])
    ).toBe(true);
  });

  it("rejects bool text and values bool_in rejects, at planning", async () => {
    for (const bad of ["'maybe'", "''", "'tru e'", "'2'"]) {
      await expect(
        whereOf(`SELECT id FROM item WHERE ok = ${bad}`),
        bad
      ).rejects.toThrow(UnsupportedSqlError);
    }
    for (const bad of [2, 0.5]) {
      const w = await whereOf("SELECT id FROM item WHERE ok = $1");
      expect(() => evalExpr(w, { ok: true }, [bad]), String(bad)).toThrow(
        UnsupportedSqlError
      );
    }
  });

  it("ordered bool comparisons keep the constant's spelling for the seed", async () => {
    const w = await whereOf("SELECT id FROM item WHERE ok >= 'f'");
    expect(evalExpr(w, { ok: false }, [])).toBe(true);
    expect(toSql(w)).toBe(`("ok" >= 'f')`);
  });

  it("reads bytea hex per byteain (case, whitespace between pairs)", async () => {
    const row = { bin: "\\xdeadbeef" };
    expect(
      await fresh(String.raw`SELECT id FROM item WHERE bin = '\xDEADBEEF'`, row)
    ).toBe(true);
    expect(
      await fresh(
        String.raw`SELECT id FROM item WHERE bin = '\xde ad be ef'`,
        row
      )
    ).toBe(true);
    expect(
      await fresh("SELECT id FROM item WHERE bin = $1", row, [
        Buffer.from("deadbeef", "hex")
      ])
    ).toBe(true);
    expect(
      await fresh(String.raw`SELECT id FROM item WHERE bin = '\x'`, {
        bin: "\\x"
      })
    ).toBe(true);
  });

  it("rejects escape-format and invalid hex bytea text at planning", async () => {
    for (const bad of ["abc", "\\xzz", "\\xdea"]) {
      const w = await whereOf("SELECT id FROM item WHERE bin = $1");
      expect(() => evalExpr(w, { bin: "\\x" }, [bad]), bad).toThrow(
        UnsupportedSqlError
      );
    }
  });

  it("Date params normalize through the canonicalize chokepoint", async () => {
    expect(
      await fresh(
        "SELECT id FROM item WHERE at = $1",
        { at: "2020-01-01 00:00:00+00" },
        [new Date("2020-01-01T00:00:00Z")]
      )
    ).toBe(true);
  });

  it("shared plan IR compiles twice and renders its spelling", async () => {
    const wb = await whereOf("SELECT id FROM item WHERE ok = 'f'");
    expect(evalExpr(wb, { ok: false }, [])).toBe(true);
    expect(evalExpr(wb, { ok: false }, [])).toBe(true);
    expect(toSql(wb)).toBe(`("ok" = 'f')`);
    const wu = await whereOf("SELECT id FROM item WHERE u = $1");
    expect(evalExpr(wu, { u: CANON }, [UPPER])).toBe(true);
    expect(evalExpr(wu, { u: CANON }, [UPPER])).toBe(true);
    expect(toSql(wu)).toBe('("u" = $1)');
  });
});

describe("IN lists resolve one class per deduction site", () => {
  const fresh = async (sql: string, row: Row, params: unknown[] = []) =>
    evalExpr(await whereOf(sql), row, params);

  it("pools constants with the lhs under one common type", async () => {
    expect(await fresh("SELECT id FROM item WHERE '05' IN ('5', 7)", {})).toBe(
      true
    );
    expect(
      await fresh("SELECT id FROM item WHERE '05' NOT IN ('5', 7)", {})
    ).toBe(false);
    expect(
      await fresh("SELECT id FROM item WHERE score IN (1, '05')", { score: 5 })
    ).toBe(true);
  });

  it("an all-unknown pool resolves as text", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE 'a' IN ('b', name)", {
        name: "a"
      })
    ).toBe(true);
    expect(await fresh("SELECT id FROM item WHERE '05' IN ('5')", {})).toBe(
      false
    );
  });

  it("params deduce one exact type across pool and branches", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE $1 IN (name, id)")
    ).rejects.toThrow(/inconsistent types for parameter \$1/);
    await expect(
      whereOf("SELECT id FROM item WHERE $1 IN ('05', id)")
    ).rejects.toThrow(/inconsistent types for parameter \$1/);
    await expect(
      whereOf("SELECT id FROM item WHERE $1 IN (score, price)")
    ).rejects.toThrow(/inconsistent types for parameter \$1/);
    expect(
      await fresh("SELECT id FROM item WHERE $1 IN ('05', 5)", {}, ["05"])
    ).toBe(true);
  });

  it("a literal lhs must parse at every deduction site", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE '5' IN (score, price)", {
        score: 5,
        price: "9"
      })
    ).toBe(true);
    await expect(
      whereOf("SELECT id FROM item WHERE '2.5' IN (score, price)")
    ).rejects.toThrow(UnsupportedSqlError);
  });

  it("mixed-family lists reject at planning", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE '05' IN (name, id)")
    ).rejects.toThrow(/cannot compare/);
    await expect(
      whereOf("SELECT id FROM item WHERE '5' IN ('05', id)")
    ).rejects.toThrow(/cannot compare/);
  });

  it("NULL items keep IN's null semantics", async () => {
    expect(
      await fresh("SELECT id FROM item WHERE score IN (1, NULL)", { score: 2 })
    ).toBe(null);
  });

  it("numeric text constants validate per the input function", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE score = '2.5'")
    ).rejects.toThrow(UnsupportedSqlError);
    expect(
      await fresh("SELECT id FROM item WHERE score = ' 5 '", { score: 5 })
    ).toBe(true);
    expect(
      await fresh("SELECT id FROM item WHERE price = '2.5'", { price: "2.5" })
    ).toBe(true);
  });
});

const thread = async (sql: string) => {
  const q = await parseSql(sql);
  bind(q);
  for (const s of q.select) compileRowExpr(s.expr, []);
  if (q.where) compileRowExpr(q.where, []);
  return q;
};

const selectOf = async (sql: string): Promise<Expr> =>
  (await thread(sql)).select[0]!.expr;

describe("scalar function signatures validate at planning", () => {
  it("rejects every call Postgres rejects", async () => {
    for (const sql of [
      "SELECT id FROM item WHERE lower(a) = 'x'", // lower(int)
      "SELECT id FROM item WHERE lower(2.5) = 'x'", // lower(numeric)
      "SELECT id FROM item WHERE upper(ok) = 'x'", // upper(bool)
      "SELECT id FROM item WHERE lower(name, name) = 'x'", // arity
      "SELECT lower() FROM item",
      "SELECT id FROM item WHERE length(a) = 1", // length(int)
      "SELECT id FROM item WHERE char_length(bin) = 1", // no bytea overload
      "SELECT concat() FROM item",
      "SELECT id FROM item WHERE abs(name) = '1'", // abs(text)
      "SELECT id FROM item WHERE abs(ok) = 1", // abs(bool)
      "SELECT id FROM item WHERE abs('xyz') = 1", // float8in rejects
      "SELECT round() FROM item",
      "SELECT round(price, 1, 2) FROM item",
      "SELECT id FROM item WHERE round(ratio, 2) = 1", // no round(float8, int)
      "SELECT id FROM item WHERE round(price, big) = 1", // (numeric, bigint)
      "SELECT id FROM item WHERE round(price, 2.5) = 1", // (numeric, numeric)
      "SELECT id FROM item WHERE round(price, name) = 1", // (numeric, text)
      "SELECT id FROM item WHERE round(price, 'zz') = 1" // int4in rejects
    ]) {
      await expect(thread(sql), sql).rejects.toThrow(UnsupportedSqlError);
    }
  });

  it("rejects what the engine cannot render faithfully, loudly", async () => {
    for (const sql of [
      "SELECT concat(ratio) FROM item",
      "SELECT id FROM item WHERE ratio::text = '1e+20'",
      "SELECT id FROM item WHERE ratio::varchar = '1e+20'",
      "SELECT id FROM item WHERE length((ratio + 1)::text) > 3",
      "SELECT ratio::text FROM item"
    ]) {
      await expect(thread(sql), sql).rejects.toThrow(UnsupportedSqlError);
    }
    await expect(
      thread("SELECT round(price, $1::int) FROM item")
    ).resolves.toBeDefined();
  });

  it("float text goes through ::numeric, exactly", async () => {
    const c = await selectOf("SELECT (ratio::numeric)::text FROM item");
    expect(c.ptype).toBe("text");
    expect(evalExpr(c, { ratio: 1e20 }, [])).toBe("100000000000000000000");
    const w = await whereOf("SELECT id FROM item WHERE name = $1::text");
    expect(evalExpr(w, { name: "x" }, ["x"])).toBe(true);
  });

  it("gives untyped params the class PG's own resolution infers", async () => {
    const w = await whereOf("SELECT id FROM item WHERE round(price, $1) > 0");
    const scale = (w as Extract<Expr, { kind: "binary" }>).left as Extract<
      Expr,
      { kind: "func" }
    >;
    expect(scale.args[1]!.ptype).toBe("int");
    expect(scale.ptype).toBe("numeric");

    const one = await selectOf("SELECT round($1) FROM item");
    expect((one as Extract<Expr, { kind: "func" }>).args[0]!.ptype).toBe(
      "float"
    );
    expect(one.ptype).toBe("float");

    const two = await selectOf("SELECT round($1, $2) FROM item");
    const twoF = two as Extract<Expr, { kind: "func" }>;
    expect(twoF.args[0]!.ptype).toBe("numeric");
    expect(twoF.args[1]!.ptype).toBe("int");

    const a = await selectOf("SELECT abs($1) FROM item");
    expect(a.ptype).toBe("float");

    const both = await thread(
      "SELECT id FROM item WHERE lower($1) = 'x' AND abs($1) > 0"
    );
    const items = (both.where as Extract<Expr, { kind: "and" }>).items;
    const site = (e: Expr) =>
      (
        (e as Extract<Expr, { kind: "binary" }>).left as Extract<
          Expr,
          { kind: "func" }
        >
      ).args[0]!;
    expect(site(items[0]!).ptype).toBe("text");
    expect(site(items[1]!).ptype).toBe("float");
  });

  it("round matches PG: strict NULL, half-even float, clamped scale", async () => {
    const f = await selectOf("SELECT round(ratio) FROM item");
    expect(evalExpr(f, { ratio: 2.5 }, [])).toBe(2);
    expect(evalExpr(f, { ratio: 3.5 }, [])).toBe(4);
    expect(evalExpr(f, { ratio: -2.5 }, [])).toBe(-2);

    const n = await selectOf("SELECT round(price) FROM item");
    expect(evalExpr(n, { price: "2.5" }, [])).toBe("3");

    const s = await selectOf("SELECT round(price, $1) FROM item");
    expect(evalExpr(s, { price: "1.2" }, [5])).toBe("1.20000");
    expect(evalExpr(s, { price: "1.2" }, [null])).toBe(null);
    expect(evalExpr(s, { price: "12345.6" }, [-20000])).toBe("0");
    const clamped = evalExpr(s, { price: "1.5" }, [16383]) as string;
    expect(clamped.length).toBe(16385); // "1." + 16383 digits
    expect(evalExpr(s, { price: "1.5" }, [16384])).toBe(clamped);
    expect(evalExpr(s, { price: "1.5" }, [2000000000])).toBe(clamped);

    const nul = await selectOf("SELECT round(price, NULL) FROM item");
    expect(evalExpr(nul, { price: "1.5" }, [])).toBe(null);
  });

  it("round widens int operands to numeric, like PG", async () => {
    const i = await selectOf("SELECT round(score, 5) FROM item");
    expect(evalExpr(i, { score: 42 }, [])).toBe("42.00000");
    const b = await selectOf("SELECT round(big, 2) FROM item");
    expect(evalExpr(b, { big: "9223372036854775807" }, [])).toBe(
      "9223372036854775807.00"
    );
  });

  it("unknown constants resolve as PG resolves them (float8)", async () => {
    const r = await selectOf("SELECT round('2.5') FROM item");
    expect(evalExpr(r, {}, [])).toBe(2);
    const a = await selectOf("SELECT abs('-5.5') FROM item");
    expect(evalExpr(a, {}, [])).toBe(5.5);
  });

  it("length counts bytea octets from hex text, text by code points", async () => {
    const l = await selectOf("SELECT length(bin) FROM item");
    expect(evalExpr(l, { bin: "\\x4f2a" }, [])).toBe(2);
    expect(evalExpr(l, { bin: "\\x" }, [])).toBe(0);
    const t = await selectOf("SELECT length(name) FROM item");
    expect(evalExpr(t, { name: "héllo" }, [])).toBe(5);
  });

  it("concat renders through PG output functions", async () => {
    const c = await selectOf("SELECT concat(ok, price, name) FROM item");
    expect(evalExpr(c, { ok: true, price: "1.50", name: "x" }, [])).toBe(
      "t1.50x"
    );
    expect(evalExpr(c, { ok: false, price: null, name: "x" }, [])).toBe("fx");
  });
});

describe("integer widths", () => {
  it("int4: products and sums past 2^31 raise, never silently continue", async () => {
    const w = await whereOf("SELECT id FROM item WHERE score * score > 0");
    const mul = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(() => evalExpr(mul, { score: 100000 }, [])).toThrow(
      /integer out of range/
    );
    const add = (
      (await whereOf("SELECT id FROM item WHERE score + 1 > 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(() => evalExpr(add, { score: 2147483647 }, [])).toThrow(
      /integer out of range/
    );
    expect(evalExpr(add, { score: 2147483646 }, [])).toBe(2147483647);
  });

  it("int2: its own width, PG's own wording", async () => {
    const w = await whereOf("SELECT id FROM item WHERE sm + sm > 0");
    const add = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(add.ptype).toBe("int2");
    expect(() => evalExpr(add, { sm: 32767 }, [])).toThrow(
      /smallint out of range/
    );
    expect(evalExpr(add, { sm: 100 }, [])).toBe(200);
    const abs = (
      (await whereOf("SELECT id FROM item WHERE abs(sm) > 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(() => evalExpr(abs, { sm: -32768 }, [])).toThrow(
      /smallint out of range/
    );
  });

  it("negation and division corners raise like PG", async () => {
    const neg = (
      (await whereOf("SELECT id FROM item WHERE -score > 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(() => evalExpr(neg, { score: -2147483648 }, [])).toThrow(
      /integer out of range/
    );
    const div = (
      (await whereOf(
        "SELECT id FROM item WHERE score / $1::int > 0"
      )) as Extract<Expr, { kind: "binary" }>
    ).left;
    expect(() => evalExpr(div, { score: -2147483648 }, [-1])).toThrow(
      /integer out of range/
    );
  });

  it("::int enforces the width it names (and renders it)", async () => {
    const w = await whereOf("SELECT id FROM item WHERE big::int = 0");
    const cast = (w as Extract<Expr, { kind: "binary" }>).left;
    expect(() => evalExpr(cast, { big: "5000000000" }, [])).toThrow(
      /integer out of range/
    );
    expect(evalExpr(cast, { big: "50" }, [])).toBe(50);
    expect(toSql(cast)).toBe('("big")::integer');
  });

  it("integer bounds reject at planning when the input function would", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE score = '5000000000'")
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      whereOf("SELECT id FROM item WHERE sm = '40000'")
    ).rejects.toThrow(UnsupportedSqlError);
  });
});

describe("non-finite floats", () => {
  it("propagates NaN/Infinity as PG text values through arithmetic", async () => {
    const add = (
      (await whereOf("SELECT id FROM item WHERE ratio + 1 > 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(evalExpr(add, { ratio: "Infinity" }, [])).toBe("Infinity");
    expect(evalExpr(add, { ratio: "NaN" }, [])).toBe("NaN");
    expect(evalExpr(add, { ratio: 1.5 }, [])).toBe(2.5);
  });

  it("raises PG's overflow/underflow only from finite operands", async () => {
    const mul = (
      (await whereOf("SELECT id FROM item WHERE ratio * ratio > 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(() => evalExpr(mul, { ratio: 1e300 }, [])).toThrow(
      /value out of range: overflow/
    );
    expect(() => evalExpr(mul, { ratio: 1e-300 }, [])).toThrow(
      /value out of range: underflow/
    );
    expect(evalExpr(mul, { ratio: "Infinity" }, [])).toBe("Infinity");
  });

  it("orders -Infinity < finite < Infinity < NaN, with NaN = NaN", () => {
    expect(compareClassValues("-Infinity", -1e308, "number")).toBeLessThan(0);
    expect(compareClassValues(1e308, "Infinity", "number")).toBeLessThan(0);
    expect(compareClassValues("Infinity", "NaN", "number")).toBeLessThan(0);
    expect(compareClassValues("NaN", "NaN", "number")).toBe(0);
    expect(compareClassValues("-Infinity", "-5", "number")).toBeLessThan(0);
  });

  it("float4 arithmetic rounds to single precision", async () => {
    const add = (
      (await whereOf("SELECT id FROM item WHERE f4 + f4 = f4")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(add.ptype).toBe("float4");
    const f4 = Math.fround(0.1);
    expect(evalExpr(add, { f4 }, [])).toBe(Math.fround(f4 + f4));
  });

  it("float % does not exist, as in PG", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE ratio % 2 = 0")
    ).rejects.toThrow(/operator does not exist/);
  });

  it("float-vs-exact comparisons resolve through float8, as PG does", async () => {
    const w = await whereOf("SELECT id FROM item WHERE ratio = price");
    expect(
      compileRowPredicate(
        w,
        []
      )({
        ratio: 0.1,
        price: "0.1000000000000000055511151231257827"
      })
    ).toBe(true);
    const w2 = await whereOf("SELECT id FROM item WHERE big = ratio");
    expect(
      compileRowPredicate(
        w2,
        []
      )({
        big: "9007199254740993",
        ratio: 9007199254740992
      })
    ).toBe(true);
  });

  it("float->numeric casts carry PG's %.15g / %.6g, not shortest text", async () => {
    const c15 = (
      (await whereOf(
        "SELECT id FROM item WHERE ratio::numeric = 1"
      )) as Extract<Expr, { kind: "binary" }>
    ).left;
    expect(evalExpr(c15, { ratio: 0.30000000000000004 }, [])).toBe("0.3");
    expect(evalExpr(c15, { ratio: 1e20 }, [])).toBe("100000000000000000000");
    expect(evalExpr(c15, { ratio: 1.5e-7 }, [])).toBe("0.00000015");
    const c6 = (
      (await whereOf("SELECT id FROM item WHERE f4::numeric = 1")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(evalExpr(c6, { f4: Math.fround(3.14159265) }, [])).toBe("3.14159");
    expect(evalExpr(c6, { f4: Math.fround(0.3) }, [])).toBe("0.3");
  });

  it("non-finite into integer casts raises PG's wording per source", async () => {
    const fromFloat = (
      (await whereOf("SELECT id FROM item WHERE ratio::int = 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(() => evalExpr(fromFloat, { ratio: "NaN" }, [])).toThrow(
      /integer out of range/
    );
    const fromNumeric = (
      (await whereOf("SELECT id FROM item WHERE price::int = 0")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(() => evalExpr(fromNumeric, { price: "NaN" }, [])).toThrow(
      /cannot convert NaN to integer/
    );
    expect(() => evalExpr(fromNumeric, { price: "Infinity" }, [])).toThrow(
      /cannot convert infinity to integer/
    );
  });
});

describe("input functions raise, never NULL", () => {
  it("per-row text casts raise exactly where PG's input function does", async () => {
    const b = (await whereOf(
      "SELECT id FROM item WHERE name::bool"
    )) as Extract<Expr, { kind: "cast" }>;
    expect(evalExpr(b, { name: "yes" }, [])).toBe(true);
    expect(() => evalExpr(b, { name: "maybe" }, [])).toThrow(
      /invalid input syntax for type boolean: "maybe"/
    );
    const n = (
      (await whereOf("SELECT id FROM item WHERE name::numeric = 1")) as Extract<
        Expr,
        { kind: "binary" }
      >
    ).left;
    expect(evalExpr(n, { name: "1e2" }, [])).toBe("100");
    expect(evalExpr(n, { name: "NaN" }, [])).toBe("NaN");
    expect(() => evalExpr(n, { name: "abc" }, [])).toThrow(
      /invalid input syntax for type numeric: "abc"/
    );
  });

  it("invalid constants reject at planning, not per row", async () => {
    for (const sql of [
      "SELECT id FROM item WHERE 'maybe'::bool",
      "SELECT id FROM item WHERE u = 'not-a-uuid'::uuid",
      "SELECT id FROM item WHERE at = 'Jan 15 2024'::timestamptz",
      "SELECT id FROM item WHERE price = 'abc'::numeric"
    ]) {
      await expect(whereOf(sql), sql).rejects.toThrow(UnsupportedSqlError);
    }
  });

  it("casts PG does not have reject at planning", async () => {
    for (const sql of [
      "SELECT id FROM item WHERE big::bool",
      "SELECT id FROM item WHERE ratio::bool",
      "SELECT id FROM item WHERE ok::int8 = 1",
      "SELECT id FROM item WHERE ok::float8 = 1",
      "SELECT id FROM item WHERE name::float8 = 1",
      "SELECT id FROM item WHERE f4::text = 'x'"
    ]) {
      await expect(whereOf(sql), sql).rejects.toThrow(UnsupportedSqlError);
    }
    const w = await whereOf("SELECT id FROM item WHERE ok::int = 1");
    expect(evalExpr(w, { ok: true }, [])).toBe(true);
  });
});

describe("typed param values validate at planning", () => {
  const plan = async (sql: string, params: unknown[]): Promise<Expr> => {
    const q = await parseSql(sql);
    bind(q);
    compileRowExpr(q.where!, params);
    return q.where!;
  };

  it("rejects values the class's input function rejects", async () => {
    await expect(
      plan("SELECT id FROM item WHERE at > $1::timestamptz", ["Jan 15 2024"])
    ).rejects.toThrow(/ISO 8601/);
    await expect(
      plan("SELECT id FROM item WHERE score = $1::int", [5000000000])
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      plan("SELECT id FROM item WHERE u = $1::uuid", ["garbage"])
    ).rejects.toThrow(UnsupportedSqlError);
    await expect(
      plan("SELECT id FROM item WHERE price = $1::numeric", ["1e2"])
    ).resolves.toBeDefined();
    await expect(
      plan("SELECT id FROM item WHERE ratio = $1::float8", ["Infinity"])
    ).resolves.toBeDefined();
  });
});

describe("qual and strict-fold error semantics", () => {
  const pred = async (sql: string): Promise<(r: Row) => boolean> => {
    const w = await whereOf(sql);
    return compileRowPredicate(w, []);
  };

  it("a data error raises only when membership depends on it", async () => {
    const p = await pred(
      "SELECT id FROM item WHERE score + 1 > 0 AND name LIKE 'x%'"
    );
    expect(p({ score: 2147483647, name: "y" })).toBe(false);
    expect(() => p({ score: 2147483647, name: "x1" })).toThrow(
      /integer out of range/
    );
    expect(p({ score: 2147483647, name: null })).toBe(false);
  });

  it("flattens nested ANDs like PG's canonicalized quals", async () => {
    const p = await pred(
      "SELECT id FROM item WHERE ok AND (score + 1 > 0 AND name LIKE 'x%')"
    );
    expect(p({ ok: true, score: 2147483647, name: "y" })).toBe(false);
    expect(() => p({ ok: true, score: 2147483647, name: "x1" })).toThrow(
      /integer out of range/
    );
  });

  it("OR keeps written-order evaluation, as PG's executor does", async () => {
    const p = await pred("SELECT id FROM item WHERE ok OR score + 1 > 0");
    expect(p({ ok: true, score: 2147483647 })).toBe(true);
    const p2 = await pred("SELECT id FROM item WHERE score + 1 > 0 OR ok");
    expect(() => p2({ ok: true, score: 2147483647 })).toThrow(
      /integer out of range/
    );
  });

  it("a constant NULL beside a strict operator folds without evaluating", async () => {
    const p = await pred("SELECT id FROM item WHERE NOT (NULL < score + 1)");
    expect(p({ score: 2147483647 })).toBe(false);
  });
});

describe("time text compares chronologically over PG's whole range", () => {
  const t = (a: string, b: string): number => compareClassValues(a, b, "time");

  it("BC counts backwards; far years order past JS Date's range", () => {
    expect(t("0100-06-01 12:00:00 BC", "0099-06-01 12:00:00 BC")).toBeLessThan(
      0
    );
    expect(t("0001-01-01 00:00:00 BC", "0001-01-01 00:00:00")).toBeLessThan(0);
    expect(t("9999-12-31 23:59:59", "30000-01-01 00:00:00")).toBeLessThan(0);
    expect(t("294276-12-31 23:59:59.999999", "infinity")).toBeLessThan(0);
    expect(t("-infinity", "4714-11-24 00:00:00 BC")).toBeLessThan(0);
  });

  it("microseconds stay exact; 7th fraction digits round half-even with carry", () => {
    expect(
      t("2024-01-15 10:30:00.000001", "2024-01-15 10:30:00.000002")
    ).toBeLessThan(0);
    expect(t("2024-01-15 10:30:00.1234565", "2024-01-15 10:30:00.123456")).toBe(
      0
    );
    expect(t("2024-01-15 10:30:00.1234575", "2024-01-15 10:30:00.123458")).toBe(
      0
    );
    expect(t("2024-01-15 10:30:00.9999999", "2024-01-15 10:30:01")).toBe(0);
  });

  it("zone offsets fold to the UTC axis; hour 24 folds to the next day", () => {
    expect(t("2024-01-15 10:30:00+05:30", "2024-01-15 05:00:00+00")).toBe(0);
    expect(t("2024-01-15T10:30:00Z", "2024-01-15 10:30:00+00")).toBe(0);
    expect(t("2024-01-15 24:00:00", "2024-01-16 00:00:00")).toBe(0);
    expect(t("2024-01-15", "2024-01-15 00:00:00")).toBe(0);
  });
});

describe("total typing", () => {
  const binOf = (e: Expr): Extract<Expr, { kind: "binary" }> =>
    e as Extract<Expr, { kind: "binary" }>;

  it("::text over an unclassified column is refused, never String()'d", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE meta::text = 'x'")
    ).rejects.toThrow(UnsupportedSqlError);
    const w = await whereOf("SELECT id FROM item WHERE score::text = '5'");
    expect(evalExpr(w, { score: 5 }, [])).toBe(true);
  });

  it("bare numeric spellings keep their grammar class beside any sibling", async () => {
    const w = await whereOf("SELECT id FROM item WHERE score > 1.5 * 2");
    expect(binOf(w).right.ptype).toBe("numeric");
    expect(evalExpr(w, { score: 4 }, [])).toBe(true);
    expect(evalExpr(w, { score: 3 }, [])).toBe(false);
    expect(toSql(w, [])).toBe('("score" > (1.5 * 2))');
    const cmp = await whereOf("SELECT id FROM item WHERE sm > 1.5");
    expect(evalExpr(cmp, { sm: 2 }, [])).toBe(true);
    expect(evalExpr(cmp, { sm: 1 }, [])).toBe(false);
  });

  it("quoted constants take the sibling class through its input function", async () => {
    const w = await whereOf("SELECT id FROM item WHERE sm + '1' > 0");
    const add = binOf(binOf(w).left);
    expect(add.ptype).toBe("int2");
    expect(add.right.ptype).toBe("int2");
    expect(evalExpr(add, { sm: 5 }, [])).toBe(6);
    expect(() => evalExpr(add, { sm: 32767 }, [])).toThrow(
      "smallint out of range"
    );
    await expect(
      whereOf("SELECT id FROM item WHERE score + 'abc' > 0")
    ).rejects.toThrow('invalid input syntax for type integer: "abc"');
    await expect(
      whereOf("SELECT id FROM item WHERE ratio + '1e999' > 0")
    ).rejects.toThrow(/out of range for type double precision/);
  });

  it("a float4 sibling coerces the constant to the float4 value", async () => {
    const w = await whereOf("SELECT id FROM item WHERE f4 * '0.1' > 0");
    const mul = binOf(binOf(w).left);
    expect(mul.ptype).toBe("float4");
    const lit = mul.right as Extract<Expr, { kind: "literal" }>;
    expect(lit.ptype).toBe("float4");
    expect(lit.value).toBe("0.1");
    const f4 = Math.fround(0.2);
    expect(evalExpr(mul, { f4 }, [])).toBe(Math.fround(f4 * Math.fround(0.1)));
  });

  it("bare params take the sibling class; values validate at planning", async () => {
    const q = await parseSql("SELECT id FROM item WHERE score + $1 > 0");
    bind(q);
    expect(() => compileRowExpr(q.where!, [7])).not.toThrow();
    expect(() => compileRowExpr(q.where!, ["abc"])).toThrow(
      /invalid input syntax for type integer: "abc"/
    );
    expect(() => compileRowExpr(q.where!, [2147483648])).toThrow(
      /out of range for type integer/
    );
  });

  it("NULL takes the sibling class; strict ops fold to NULL", async () => {
    const w = await whereOf("SELECT id FROM item WHERE score + NULL > 0");
    const add = binOf(binOf(w).left);
    expect(add.ptype).toBe("int");
    expect(evalExpr(add, { score: 1 }, [])).toBe(null);
  });

  it("refuses what PG refuses, in PG's words", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE $1 + $2 > 0")
    ).rejects.toThrow(/operator is not unique: unknown \+ unknown/);
    await expect(whereOf("SELECT id FROM item WHERE -$1 > 0")).rejects.toThrow(
      /operator is not unique: - unknown/
    );
    await expect(whereOf("SELECT id FROM item WHERE -'2' > 0")).rejects.toThrow(
      /operator is not unique: - unknown/
    );
    await expect(
      whereOf("SELECT id FROM item WHERE name + 1 > 0")
    ).rejects.toThrow(/operator does not exist: text \+ integer/);
    await expect(
      whereOf("SELECT id FROM item WHERE ok + 1 > 0")
    ).rejects.toThrow(/operator does not exist: boolean \+ integer/);
    await expect(
      whereOf("SELECT id FROM item WHERE -name > 0")
    ).rejects.toThrow(/operator does not exist: - text/);
    await expect(
      whereOf("SELECT id FROM item WHERE meta + 1 > 0")
    ).rejects.toThrow(/unsupported column type/);
  });

  it("refuses date arithmetic as unsupported (it exists in PG)", async () => {
    await expect(
      whereOf("SELECT id FROM item WHERE day + 1 > day")
    ).rejects.toThrow(/date arithmetic is not supported/);
  });

  it("aggregate arguments are classed or refused, as in PG", async () => {
    const agg = async (sql: string): Promise<Expr> => {
      const q = await parseSql(sql);
      bind(q);
      return q.select[0]!.expr;
    };
    await expect(agg("SELECT sum(name) AS x FROM item")).rejects.toThrow(
      /function sum\(text\) does not exist/
    );
    await expect(agg("SELECT sum($1) AS x FROM item")).rejects.toThrow(
      /function sum\(unknown\) is not unique/
    );
    await expect(agg("SELECT sum(meta) AS x FROM item")).rejects.toThrow(
      /unsupported column type/
    );
    await expect(agg("SELECT min(meta) AS x FROM item")).rejects.toThrow(
      /unsupported column type/
    );
    await expect(
      agg("SELECT min('abc') AS x FROM item")
    ).resolves.toMatchObject({ ptype: "text" });
    await expect(
      agg("SELECT count(meta) AS x FROM item")
    ).resolves.toBeDefined();
  });
});
