import { describe, it, expect } from "vitest";
import { initParser, parseSql } from "../src/parser/parse";
import {
  collectTables,
  qualifiedTable,
  qualifyTableNames,
  splitQualified
} from "../src/parser/ir";

describe("schema-qualified table identity", () => {
  it("resolves unqualified names against the default schema", async () => {
    await initParser();
    const q = await parseSql("SELECT id FROM users WHERE room_id = $1");
    qualifyTableNames(q, "app");
    expect(collectTables(q.from)).toEqual([
      { name: "app.users", alias: "users" }
    ]);
  });

  it("keeps explicit schemas and leaves aliases bare", async () => {
    await initParser();
    const q = await parseSql(
      "SELECT c.id AS id, u.name AS name FROM audit.comments c JOIN users u ON u.id = c.user_id"
    );
    qualifyTableNames(q, "public");
    expect(collectTables(q.from)).toEqual([
      { name: "audit.comments", alias: "c" },
      { name: "public.users", alias: "u" }
    ]);
  });

  it("qualifies EXISTS subquery tables", async () => {
    await initParser();
    const q = await parseSql(
      "SELECT u.id AS id FROM users u WHERE EXISTS (SELECT 1 FROM other.comments c WHERE c.user_id = u.id)"
    );
    qualifyTableNames(q, "public");
    const where = q.where!;
    expect(where.kind).toBe("exists");
    if (where.kind === "exists") {
      expect(collectTables(where.subquery.from)).toEqual([
        { name: "other.comments", alias: "c" }
      ]);
    }
  });

  it("same-named tables in two schemas stay distinct", async () => {
    await initParser();
    const q = await parseSql(
      "SELECT a.id AS aid, b.id AS bid FROM one.events a JOIN two.events b ON a.id = b.id"
    );
    qualifyTableNames(q, "public");
    const names = collectTables(q.from).map(t => t.name);
    expect(new Set(names).size).toBe(2);
  });

  it("quotes non-plain parts and stays injective for dotted names", async () => {
    expect(qualifiedTable("a.b", "c", "public")).toBe('"a.b".c');
    expect(qualifiedTable("a", "b.c", "public")).toBe('a."b.c"');
    expect(qualifiedTable(undefined, "users", "public")).toBe("public.users");
    await initParser();
    const q = await parseSql('SELECT t.id AS id FROM "a.b".t');
    qualifyTableNames(q, "public");
    expect(collectTables(q.from)).toEqual([{ name: '"a.b".t', alias: "t" }]);
  });

  it("splitQualified inverts qualifiedTable and rejects malformed text", () => {
    for (const [schema, name] of [
      ["a.b", "c"],
      ["a", "b.c"],
      ['a"b', 'c.d"e'],
      ["MySchema", "MyTable"],
      ["public", "users"]
    ] as const) {
      expect(splitQualified(qualifiedTable(schema, name, "x"))).toEqual({
        schema,
        name
      });
    }
    expect(splitQualified("users")).toEqual({ name: "users" });
    expect(splitQualified('"Users"')).toEqual({ name: "Users" });
    expect(() => splitQualified("a.b.c")).toThrow(/quote/);
    expect(() => splitQualified('"a"b')).toThrow(/quote/);
  });
});
