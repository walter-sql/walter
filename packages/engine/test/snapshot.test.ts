import { describe, it, expect } from "vitest";
import { absorbed, absorbedThrough, parseSnapshot } from "../src/lazy/snapshot";

describe("snapshot membership", () => {
  it("absorbedThrough(n) absorbs exactly xids <= n", () => {
    const s = absorbedThrough(10);
    expect(absorbed(s, 1)).toBe(true);
    expect(absorbed(s, 10)).toBe(true);
    expect(absorbed(s, 11)).toBe(false);
  });

  it("xip members are in progress, hence unabsorbed", () => {
    const s = parseSnapshot("100:110:103,107");
    expect(absorbed(s, 99)).toBe(true);
    expect(absorbed(s, 104)).toBe(true);
    expect(absorbed(s, 103)).toBe(false);
    expect(absorbed(s, 107)).toBe(false);
    expect(absorbed(s, 110)).toBe(false);
    expect(absorbed(s, 200)).toBe(false);
  });

  it("parses an empty xip list", () => {
    const s = parseSnapshot("745:745:");
    expect(absorbed(s, 744)).toBe(true);
    expect(absorbed(s, 745)).toBe(false);
  });

  it("promotes stream xids across the epoch boundary, both directions", () => {
    const e1 = 1n << 32n;
    const after = parseSnapshot(`${e1 + 3n}:${e1 + 5n}:`);
    expect(absorbed(after, 4294967290)).toBe(true);
    expect(absorbed(after, 2)).toBe(true);
    expect(absorbed(after, 7)).toBe(false);
    const before = parseSnapshot(`${e1 - 10n}:${e1 - 5n}:`);
    expect(absorbed(before, 3)).toBe(false);
    expect(absorbed(before, Number(e1 - 11n))).toBe(true);
  });
});
