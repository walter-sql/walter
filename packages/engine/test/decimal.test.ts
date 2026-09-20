import { describe, it, expect } from "vitest";
import { SqlEvalError } from "../src/parser/ir";
import {
  DecSum,
  canonNumeric,
  clampRoundScale,
  absDec,
  addDec,
  cmpDec,
  decExact,
  decFrom,
  mulDec,
  negDec,
  parseDec,
  renderDec,
  roundDec,
  subDec
} from "../src/parser/decimal";

const dec = (t: string) => parseDec(t)!;
const rt = (t: string) => renderDec(dec(t));

describe("decimal: parse/render round-trip", () => {
  it("round-trips PG canonical text verbatim", () => {
    for (const t of [
      "0",
      "1",
      "-1",
      "1.5",
      "1.50",
      "-1.50",
      "0.05",
      "-0.05",
      "123456789012345678901234567890.123456789",
      "0.000"
    ]) {
      expect(rt(t)).toBe(t);
    }
  });

  it("rejects non-decimal text", () => {
    for (const t of ["NaN", "1e5", "1.5e-2", "", "+1", ".5", "1.", "abc"]) {
      expect(parseDec(t)).toBeNull();
    }
  });

  it("lifts safe integers and round-trippable floats", () => {
    expect(renderDec(decFrom(42)!)).toBe("42");
    expect(renderDec(decFrom(-0.5)!)).toBe("-0.5");
    expect(renderDec(decFrom(7n)!)).toBe("7");
  });
});

describe("canonNumeric: every PG spelling to canonical text", () => {
  it("matches PG's own rendering, probed on 18.2", () => {
    const cases: Array<[string, string]> = [
      ["1e2", "100"],
      ["1E2", "100"],
      ["1e+2", "100"],
      ["-1e2", "-100"],
      ["+1e2", "100"],
      ["1.50e2", "150"],
      ["1.500e1", "15.00"],
      ["1.5e-3", "0.0015"],
      ["2e-2", "0.02"],
      [".5", "0.5"],
      ["5.", "5"],
      [".5e2", "50"],
      ["2.e3", "2000"],
      ["1_000.5", "1000.5"],
      ["1e1_0", "10000000000"],
      ["0x1_0000_0000", "4294967296"],
      ["0xFFFFFFFFFFFFFFFFFF", "4722366482869645213695"],
      ["-0X10", "-16"],
      ["0o777", "511"],
      ["0b1010", "10"],
      [" 100 ", "100"],
      ["+5", "5"],
      ["000123", "123"],
      ["00.50", "0.50"],
      ["-0.00", "0.00"]
    ];
    for (const [spelling, canonical] of cases) {
      expect(canonNumeric(spelling), spelling).toBe(canonical);
    }
  });

  it("is the identity on canonical text", () => {
    for (const t of ["0", "-1.50", "0.000", "123456789012345678901234567890"]) {
      expect(canonNumeric(t)).toBe(t);
    }
  });

  it("rejects non-numeric text and special values", () => {
    for (const t of [
      "NaN",
      "Infinity",
      "-Infinity",
      "",
      ".",
      "e5",
      "1e",
      "_1",
      "1_",
      "1__0",
      "0x",
      "abc",
      "1.2.3"
    ]) {
      expect(canonNumeric(t), t).toBeNull();
    }
  });

  it("enforces PG's overflow bounds without materializing huge values", () => {
    expect(canonNumeric("1e131071")).toHaveLength(131072);
    expect(canonNumeric("1e131072")).toBeNull();
    expect(canonNumeric("1e-16383")).toHaveLength(16385);
    expect(canonNumeric("1e-16384")).toBeNull();
    expect(canonNumeric("1e99999999999999999999")).toBeNull();
    expect(canonNumeric("1e-99999999999999999999")).toBeNull();
    expect(canonNumeric("0." + "0".repeat(16382) + "1")).toHaveLength(16385);
    expect(canonNumeric("0." + "0".repeat(16383) + "1")).toBeNull();
  });
});

describe("decFrom lifts param spellings exactly", () => {
  it("lifts non-canonical numeric strings", () => {
    expect(renderDec(decFrom("1e2")!)).toBe("100");
    expect(renderDec(decFrom("+5")!)).toBe("5");
    expect(renderDec(decFrom(".5")!)).toBe("0.5");
    expect(decFrom("abc")).toBeNull();
  });

  it("lifts exponent-form floats via their bound text", () => {
    expect(renderDec(decFrom(1e21)!)).toBe("1000000000000000000000");
    expect(renderDec(decFrom(1.5e-7)!)).toBe("0.00000015");
  });
});

describe("decimal: arithmetic with PG result-scale rules", () => {
  it("add/sub: scale = max(s1, s2)", () => {
    expect(renderDec(addDec(dec("0.1"), dec("0.2")))).toBe("0.3");
    expect(renderDec(addDec(dec("1.50"), dec("2")))).toBe("3.50");
    expect(renderDec(subDec(dec("1.0"), dec("1")))).toBe("0.0");
    expect(renderDec(subDec(dec("0.05"), dec("0.5")))).toBe("-0.45");
  });

  it("mul: scale = s1 + s2", () => {
    expect(renderDec(mulDec(dec("1.5"), dec("2.0")))).toBe("3.00");
    expect(renderDec(mulDec(dec("-0.5"), dec("0.5")))).toBe("-0.25");
  });

  it("stays exact far past float64", () => {
    const big = dec("99999999999999999999999999.99");
    expect(renderDec(addDec(big, dec("0.01")))).toBe(
      "100000000000000000000000000.00"
    );
  });

  it("neg/abs/cmp", () => {
    expect(renderDec(negDec(dec("1.50")))).toBe("-1.50");
    expect(renderDec(absDec(dec("-0.05")))).toBe("0.05");
    expect(cmpDec(dec("1.50"), dec("1.5"))).toBe(0);
    expect(cmpDec(dec("-2"), dec("-1.99"))).toBe(-1);
    expect(
      cmpDec(dec("12345678901234567890.1"), dec("12345678901234567890.2"))
    ).toBe(-1);
  });

  it("round: half away from zero, renders at the requested scale", () => {
    expect(renderDec(roundDec(dec("2.5"), 0))).toBe("3");
    expect(renderDec(roundDec(dec("-2.5"), 0))).toBe("-3");
    expect(renderDec(roundDec(dec("1.234"), 2))).toBe("1.23");
    expect(renderDec(roundDec(dec("1.235"), 2))).toBe("1.24");
    expect(renderDec(roundDec(dec("1.2"), 5))).toBe("1.20000");
    expect(renderDec(roundDec(dec("123.45"), -1))).toBe("120");
  });
});

describe("decimal: retraction-safe sum", () => {
  it("tracks the max scale of the remaining addends", () => {
    const s = new DecSum();
    s.add(dec("1.5"), 1);
    s.add(dec("2.25"), 1);
    expect(s.value()).toBe("3.75");
    s.add(dec("2.25"), -1);
    expect(s.value()).toBe("1.5");
    s.add(dec("1.5"), -1);
    expect(s.value()).toBeNull();
  });

  it("weighted adds and long churn stay exact", () => {
    const s = new DecSum();
    for (let i = 0; i < 1000; i++) s.add(dec("0.1"), 1);
    for (let i = 0; i < 999; i++) s.add(dec("0.1"), -1);
    expect(s.value()).toBe("0.1");
    s.add(dec("0.30"), 2);
    expect(s.value()).toBe("0.70");
  });
});

describe("decimal: exact float lift", () => {
  it("expands the double's exact binary value at minimal scale", () => {
    expect(renderDec(decExact(3))).toBe("3");
    expect(renderDec(decExact(0.5))).toBe("0.5");
    expect(renderDec(decExact(-0))).toBe("0");
    expect(renderDec(decExact(0.1))).toBe(
      "0.1000000000000000055511151231257827021181583404541015625"
    );
    expect(renderDec(decExact(1e23))).toBe("99999999999999991611392");
  });

  it("round-trips the extremes of the double range", () => {
    for (const v of [5e-324, -5e-324, 1.7976931348623157e308, 1e16 + 2]) {
      expect(Number(renderDec(decExact(v)))).toBe(v);
    }
  });
});

describe("roundDec bounds", () => {
  it("negative scales past the integer digits are zero, without big powers", () => {
    expect(renderDec(roundDec(dec("1.5"), -1000000))).toBe("0");
    expect(renderDec(roundDec(dec("5"), -1))).toBe("10");
    expect(renderDec(roundDec(dec("-5"), -1))).toBe("-10");
    expect(renderDec(roundDec(dec("4"), -1))).toBe("0");
    expect(renderDec(roundDec(dec("0.05"), -1))).toBe("0");
    expect(renderDec(roundDec(dec("123.45"), -1))).toBe("120");
  });

  it("raises PG's overflow when rounding grows past 131072 integer digits", () => {
    expect(() => roundDec(dec("5" + "0".repeat(131071)), -131072)).toThrow(
      SqlEvalError
    );
    expect(renderDec(roundDec(dec("4" + "0".repeat(131071)), -131072))).toBe(
      "0"
    );
  });

  it("clampRoundScale truncates and clamps to NUMERIC_DSCALE_MAX", () => {
    expect(clampRoundScale(16384)).toBe(16383);
    expect(clampRoundScale(2147483647)).toBe(16383);
    expect(clampRoundScale(16383)).toBe(16383);
    expect(clampRoundScale(2.5)).toBe(2);
    expect(clampRoundScale(NaN)).toBe(0);
    expect(clampRoundScale(-1e9)).toBe(-1e9);
  });
});
