import { describe, it, expect } from "vitest";
import { likeMatcher } from "../src/parser/eval";
import { initParser, parseSql } from "../src/parser/parse";
import { SubscriptionManager } from "../src/subscriptions/manager";
import { SchemaCatalog } from "../src/parser/catalog";
import { MemRowSource } from "../src/lazy/rowsource";
import { absorbedThrough } from "../src/lazy/snapshot";
import { StateStore } from "./state-store";
import type { ViewSubscriber } from "../src/subscriptions/shape";
import { commit, type RowOp } from "./support";

describe("likeMatcher wildcards", () => {
  it("matches % and _ like Postgres", () => {
    const m = (p: string, v: string) => likeMatcher(p, false)(v);
    expect(m("a%", "a")).toBe(true);
    expect(m("a%", "abc")).toBe(true);
    expect(m("a%", "ba")).toBe(false);
    expect(m("%b", "ab")).toBe(true);
    expect(m("a_", "ab")).toBe(true);
    expect(m("a_", "a")).toBe(false);
    expect(m("a_", "abc")).toBe(false);
    expect(m("%", "")).toBe(true);
    expect(m("_", "")).toBe(false);
    expect(m("", "")).toBe(true);
    expect(m("", "a")).toBe(false);
    expect(m("%a%b%", "xaxbx")).toBe(true);
    expect(m("%ab%ab", "abab")).toBe(true);
    expect(m("%_a", "xa")).toBe(true);
    expect(m("a%b", "a\nb")).toBe(true);
  });

  it("_ consumes one code point (astral chars included)", () => {
    const m = (p: string, v: string) => likeMatcher(p, false)(v);
    expect(m("_", "😀")).toBe(true);
    expect(m("__", "😀")).toBe(false);
    expect(m("_😀%", "x😀y")).toBe(true);
  });

  it("ILIKE folds ASCII only (C collation)", () => {
    const m = (p: string, v: string) => likeMatcher(p, true)(v);
    expect(m("A%", "abc")).toBe(true);
    expect(m("a%", "ABC")).toBe(true);
    expect(m("Ä%", "äx")).toBe(false);
  });
});

describe("likeMatcher escape (Postgres default \\)", () => {
  it("\\x is literal x", () => {
    const m = (p: string, v: string) => likeMatcher(p, false)(v);
    expect(m("a\\%", "a%")).toBe(true);
    expect(m("a\\%", "ab")).toBe(false);
    expect(m("a\\_c", "a_c")).toBe(true);
    expect(m("a\\_c", "abc")).toBe(false);
    expect(m("\\\\", "\\")).toBe(true);
    expect(m("100\\%%", "100% done")).toBe(true);
    expect(m("\\a%", "abc")).toBe(true);
  });

  it("folds escaped letters under ILIKE", () => {
    expect(likeMatcher("\\A%", true)("abc")).toBe(true);
    expect(likeMatcher("\\A%", true)("ABC")).toBe(true);
  });

  it("rejects a trailing escape like Postgres", () => {
    expect(() => likeMatcher("abc\\", false)).toThrow(
      /must not end with escape character/
    );
  });
});

describe("pathological patterns stay fast", () => {
  it("mismatching %a-repeat pattern completes in milliseconds", () => {
    const m = likeMatcher("%a".repeat(30), false);
    const v = "a".repeat(2000) + "b";
    const t0 = performance.now();
    expect(m(v)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe("LIKE ... ESCAPE is cleanly rejected", () => {
  it("rejects the like_escape rewrite from the closed vocabulary", async () => {
    await initParser();
    for (const op of ["LIKE", "NOT LIKE", "ILIKE"]) {
      await expect(
        parseSql(`SELECT s FROM t WHERE s ${op} 'a%' ESCAPE '#'`)
      ).rejects.toThrow(/like_escape/);
    }
  });
});

describe("malformed pattern error paths", () => {
  const TABLE = "public.notes";

  async function manager(rows: RowOp[]) {
    await initParser();
    const state = new StateStore();
    state.setKeyColumns(TABLE, ["id"]);
    state.ingest(rows);
    const catalog = new SchemaCatalog();
    catalog.setKeyColumns(TABLE, ["id"]);
    catalog.setColumnTypes(TABLE, { id: "int4", s: "text", p: "text" });
    const source = new MemRowSource(
      t => state.rows(t),
      () => absorbedThrough(10)
    );
    return {
      state,
      mgr: new SubscriptionManager(source, catalog, "public", 30_000)
    };
  }

  function sub(
    id: string,
    failures: string[],
    diffs: unknown[]
  ): ViewSubscriber {
    return {
      id,
      snapshot() {},
      diff(c) {
        diffs.push(JSON.parse(c));
      },
      failed() {
        failures.push(id);
      }
    };
  }

  it("constant trailing-escape pattern fails at subscribe time", async () => {
    const { mgr } = await manager([
      { table: TABLE, kind: "insert", newRow: { id: 1, s: "a", p: "a%" } }
    ]);
    await expect(
      mgr.subscribe(sub("s1", [], []), {
        sql: "SELECT id, s FROM notes WHERE s LIKE 'x\\'",
        params: []
      })
    ).rejects.toThrow(/escape character/);
    await expect(
      mgr.subscribe(sub("s2", [], []), {
        sql: "SELECT id, s FROM notes WHERE s LIKE $1",
        params: ["x\\"]
      })
    ).rejects.toThrow(/escape character/);
    expect(mgr.stats.shapes).toBe(0);
  });

  it("per-row trailing-escape pattern fails only its shape", async () => {
    const seed: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 1, s: "abc", p: "a%" } }
    ];
    const { state, mgr } = await manager(seed);

    const failures: string[] = [];
    const likeDiffs: unknown[] = [];
    const plainDiffs: unknown[] = [];
    const like = await mgr.subscribe(sub("like", failures, likeDiffs), {
      sql: "SELECT id, s FROM notes WHERE s LIKE p",
      params: []
    });
    await mgr.subscribe(sub("plain", failures, plainDiffs), {
      sql: "SELECT id, s FROM notes",
      params: []
    });
    expect(mgr.stats.shapes).toBe(2);

    const bad: RowOp[] = [
      { table: TABLE, kind: "insert", newRow: { id: 2, s: "x", p: "x\\" } }
    ];
    state.ingest(bad);
    mgr.handleTxn(commit(20, bad));
    await new Promise(r => setTimeout(r, 20));

    expect(failures).toEqual(["like"]);
    expect(like.failedBy?.message).toMatch(/escape character/);
    expect(plainDiffs).toHaveLength(1);
    expect(mgr.stats.shapes).toBe(2);
    expect(mgr.stats.failedShapes).toBe(1);
  });
});
