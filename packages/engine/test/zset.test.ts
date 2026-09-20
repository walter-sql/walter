import { describe, it, expect } from "vitest";
import {
  emptyZSet,
  canonicalize,
  rowKey,
  stableStringify,
  zsetAddRow
} from "../src/ivm/zset";

describe("zset", () => {
  it("collapses opposite weights to nothing", () => {
    const z = emptyZSet();
    zsetAddRow(z, { id: 1, x: "a" }, 1);
    zsetAddRow(z, { id: 1, x: "a" }, -1);
    expect(z.size).toBe(0);
  });

  it("sums weights on identical rows", () => {
    const z = emptyZSet();
    zsetAddRow(z, { id: 1 }, 1);
    zsetAddRow(z, { id: 1 }, 1);
    expect(z.size).toBe(1);
    expect([...z.values()][0]!.weight).toBe(2);
  });

  it("row identity is order-independent for keys", () => {
    expect(rowKey({ a: 1, b: 2 })).toBe(rowKey({ b: 2, a: 1 }));
  });

  it("distinguishes types", () => {
    expect(stableStringify(1)).not.toBe(stableStringify("1"));
    expect(stableStringify(true)).not.toBe(stableStringify(1));
    expect(stableStringify(null)).not.toBe(stableStringify(0));
  });

  it("strings containing structural delimiters cannot collide", () => {
    expect(stableStringify(["a\u0001sb"])).not.toBe(
      stableStringify(["a", "b"])
    );
    expect(stableStringify(["a\u00011:b"])).not.toBe(
      stableStringify(["a", "b"])
    );
    expect(stableStringify({ "a\u0002X": 1 })).not.toBe(
      stableStringify({ a: "X\u00021" })
    );
    expect(stableStringify(["a\u0001b"])).toBe(stableStringify(["a\u0001b"]));
  });

  it("normalizes dates and bigints", () => {
    const d = new Date("2020-01-02T03:04:05.000Z");
    expect(canonicalize(d)).toBe("2020-01-02T03:04:05.000Z");
    expect(canonicalize(42n)).toBe("42");
    expect(canonicalize(9223372036854775807n)).toBe("9223372036854775807");
    expect(canonicalize({ a: d })).toEqual({ a: "2020-01-02T03:04:05.000Z" });
  });
});
