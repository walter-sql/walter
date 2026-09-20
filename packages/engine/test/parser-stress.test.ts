import { describe, it, expect } from "vitest";
import { parseSql } from "../src/parser/parse";

describe("parser under load", () => {
  it("parses thousands of distinct statements without degrading", async () => {
    const t0 = Date.now();
    for (let i = 1; i <= 3000; i++) {
      const q = await parseSql(
        `SELECT c.id, c.body_${i}, json_build_object('id', u.id, 'name', u.name) AS author
         FROM comments c JOIN users u ON u.id = c.user_id
         WHERE c.room_id = ${i} AND c.deleted = false
         ORDER BY c.created_at DESC LIMIT ${1 + (i % 100)}`
      );
      expect(q.limit).toBe(1 + (i % 100));
    }
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it("reports syntax errors with a position and keeps working after", async () => {
    await expect(parseSql("SELEC nope")).rejects.toThrow(/syntax error/);
    const q = await parseSql("SELECT id FROM users WHERE id = $1");
    expect(q.from).toEqual({ kind: "table", name: "users", alias: "users" });
  });
});

describe("LIMIT / OFFSET spellings", () => {
  it("LIMIT ALL and LIMIT NULL mean no bound, as in Postgres", async () => {
    for (const spelling of ["LIMIT ALL", "LIMIT NULL"]) {
      const q = await parseSql(`SELECT id FROM users ${spelling}`);
      expect(q.limit).toBeUndefined();
    }
    const q = await parseSql("SELECT id FROM users LIMIT ALL OFFSET 3");
    expect(q.limit).toBeUndefined();
    expect(q.offset).toBe(3);
    const o = await parseSql("SELECT id FROM users LIMIT 5 OFFSET NULL");
    expect(o.limit).toBe(5);
    expect(o.offset).toBeUndefined();
  });

  it("still rejects non-integer LIMIT and WITH TIES", async () => {
    await expect(parseSql("SELECT id FROM users LIMIT 2.5")).rejects.toThrow(
      /integer literal/
    );
    await expect(
      parseSql("SELECT id FROM users ORDER BY id FETCH FIRST 5 ROWS WITH TIES")
    ).rejects.toThrow(/WITH TIES/);
  });
});

describe("= ANY($n) parses to the pre-fold anyParam node", () => {
  it("carries the operand, param index and negation", async () => {
    const q = await parseSql("SELECT id FROM users WHERE id = ANY ($2)");
    expect(q.where).toEqual({
      kind: "anyParam",
      operand: { kind: "column", name: "id" },
      param: 2,
      negated: false
    });
    const n = await parseSql("SELECT id FROM users WHERE id <> ALL ($1)");
    expect(n.where).toMatchObject({ kind: "anyParam", negated: true });
  });
});

describe("IN (subquery) desugars to EXISTS", () => {
  it("appends the correlation equality to the subquery WHERE", async () => {
    const q = await parseSql(
      "SELECT u.id FROM users u WHERE u.id IN (SELECT c.user_id FROM comments c WHERE c.room_id = $1)"
    );
    expect(q.where).toEqual({
      kind: "exists",
      negated: false,
      subquery: expect.objectContaining({
        where: {
          kind: "and",
          items: [
            {
              kind: "binary",
              op: "=",
              left: { kind: "column", table: "c", name: "room_id" },
              right: { kind: "param", index: 1 }
            },
            {
              kind: "binary",
              op: "=",
              left: { kind: "column", table: "c", name: "user_id" },
              right: { kind: "column", table: "u", name: "id" }
            }
          ]
        }
      })
    });
  });

  it("qualifies a bare subquery column to its table (innermost scope)", async () => {
    const q = await parseSql(
      "SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM comments)"
    );
    expect(q.where).toMatchObject({
      kind: "exists",
      subquery: {
        where: {
          kind: "binary",
          op: "=",
          left: { kind: "column", table: "comments", name: "user_id" }
        }
      }
    });
  });

  it("= ANY (subquery) is the same lowering", async () => {
    const q = await parseSql(
      "SELECT u.id FROM users u WHERE u.id = ANY (SELECT c.user_id FROM comments c)"
    );
    expect(q.where).toMatchObject({ kind: "exists", negated: false });
  });

  it("rejects NOT IN / <> ALL (three-valued NULL semantics)", async () => {
    await expect(
      parseSql(
        "SELECT u.id FROM users u WHERE u.id NOT IN (SELECT c.user_id FROM comments c)"
      )
    ).rejects.toThrow(/NOT IN \(subquery\)/);
    await expect(
      parseSql(
        "SELECT u.id FROM users u WHERE u.id <> ALL (SELECT c.user_id FROM comments c)"
      )
    ).rejects.toThrow(/subquery/);
  });

  it("rejects a bare outer column (subquery tables shadow it in PG)", async () => {
    await expect(
      parseSql(
        "SELECT id FROM users WHERE id IN (SELECT user_id FROM comments)"
      )
    ).rejects.toThrow(/qualify column references/);
  });

  it("rejects a multi-column subquery select", async () => {
    await expect(
      parseSql(
        "SELECT u.id FROM users u WHERE u.id IN (SELECT c.id, c.user_id FROM comments c)"
      )
    ).rejects.toThrow(/exactly one column/);
  });
});

describe("scalar function allowlist", () => {
  it("rejects window functions and WITHIN GROUP, never treating them as aggregates", async () => {
    await expect(
      parseSql("SELECT id, count(*) OVER () AS c FROM users")
    ).rejects.toThrow(/window functions are not supported/);
    await expect(
      parseSql(
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY id) FROM users"
      )
    ).rejects.toThrow(/WITHIN GROUP is not supported/);
  });

  it("rejects unknown functions at parse time", async () => {
    await expect(parseSql("SELECT pg_sleep(1) FROM users")).rejects.toThrow(
      /unsupported function pg_sleep\(\)/
    );
  });

  it("rejects quoted function identifiers carrying SQL punctuation", async () => {
    await expect(
      parseSql(
        `SELECT id FROM users WHERE "true; select pg_sleep(0); select true --"(id)`
      )
    ).rejects.toThrow(/unsupported function/);
  });

  it("still accepts schema-qualified supported functions", async () => {
    const q = await parseSql("SELECT pg_catalog.lower(name) FROM users");
    expect(q.select[0]?.expr).toMatchObject({ kind: "func", name: "lower" });
  });
});

describe("cast allowlist", () => {
  it("rejects unknown cast names at parse time", async () => {
    for (const sql of [
      "SELECT price::money FROM users",
      "SELECT name::txt FROM users",
      "SELECT interval '1 day' FROM users",
      `SELECT name::"char" FROM users`
    ]) {
      await expect(parseSql(sql)).rejects.toThrow(/unsupported cast/);
    }
  });

  it("rejects the unknown-cast LIKE laundering route", async () => {
    await expect(
      parseSql("SELECT id FROM users WHERE (score::money) LIKE '1e%'")
    ).rejects.toThrow(/unsupported cast ::money/);
  });

  it("rejects typmods (Postgres rounds or truncates through them)", async () => {
    for (const sql of [
      "SELECT price::numeric(10,2) FROM users",
      "SELECT name::varchar(5) FROM users",
      "SELECT name::char FROM users",
      "SELECT name::char(3) FROM users"
    ]) {
      await expect(parseSql(sql)).rejects.toThrow(/type modifier/);
    }
  });

  it("rejects array casts", async () => {
    await expect(parseSql("SELECT id::int[] FROM users")).rejects.toThrow(
      /unsupported array cast/
    );
  });

  it("rejects ::float4 (narrowing is not reproduced)", async () => {
    await expect(parseSql("SELECT price::float4 FROM users")).rejects.toThrow(
      /unsupported cast ::float4/
    );
  });

  it("still accepts implemented cast spellings", async () => {
    const q = await parseSql(
      "SELECT price::double precision, name::bpchar FROM users"
    );
    expect(q.select[0]?.expr).toMatchObject({ kind: "cast", to: "float" });
    expect(q.select[1]?.expr).toMatchObject({ kind: "cast", to: "text" });
  });
});
