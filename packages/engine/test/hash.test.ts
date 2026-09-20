import { describe, it, expect } from "vitest";
import { parseShapeSql } from "../src/parser/parse";
import { shapeFingerprint } from "../src/planner/hash";
import { SchemaCatalog } from "../src/parser/catalog";

async function fp(sql: string, params: unknown[] = []): Promise<string> {
  const shape = await parseShapeSql(sql, new SchemaCatalog(), "public");
  return shapeFingerprint(shape, params);
}

describe("shape fingerprint (canonical IR)", () => {
  it("dedups spelling variants of the same query", async () => {
    const a = await fp("SELECT id,name FROM users WHERE id = $1", [1]);
    const variants = [
      "select  id , name  from users where id=$1",
      "SELECT id, name FROM (users) WHERE (id = $1)".replace(/[()]/g, ""), // plain
      "SELECT id, name FROM public.users WHERE id = $1", // qualified spelling
      "SELECT id, name\nFROM users\nWHERE ((id = $1))" // parens + newlines
    ];
    for (const v of variants) expect(await fp(v, [1])).toBe(a);
  });

  it("distinguishes different queries and different params", async () => {
    const a = await fp("SELECT id FROM users WHERE id = $1", [1]);
    expect(await fp("SELECT id FROM users WHERE id = $1", [2])).not.toBe(a);
    expect(await fp("SELECT id FROM users WHERE id <> $1", [1])).not.toBe(a);
    expect(await fp("SELECT name FROM users WHERE id = $1", [1])).not.toBe(a);
  });
});
