import { describe, it, expect } from "vitest";
import { JoinNode } from "../src/ivm/join";
import { SourceNode } from "../src/ivm/node";
import {
  emptyTupleZSet,
  matchKey,
  tupleKey,
  tzAdd,
  tzMergeInto,
  type Tuple,
  type TupleZSet
} from "../src/ivm/tuple";
import { compareClassValues } from "../src/parser/eval";

const src = (alias: string): SourceNode => new SourceNode(alias, alias, []);

function tz(tuples: Tuple[], weight = 1): TupleZSet {
  const z = emptyTupleZSet();
  for (const t of tuples) tzAdd(z, t, weight);
  return z;
}

function makeJoin(
  joinType: "inner" | "left",
  opts: {
    residual?: (t: Tuple) => boolean;
    rightArity?: number;
  } = {}
): { stepWith: (dL: TupleZSet, dR: TupleZSet) => TupleZSet; view: TupleZSet } {
  const key = matchKey([t => t[0]], ["text"]);
  const join = new JoinNode(
    src("l"),
    src("r"),
    key,
    key,
    opts.residual ? t => opts.residual!(t) : undefined,
    joinType,
    opts.rightArity ?? 2
  );
  const view = emptyTupleZSet();
  return {
    view,
    stepWith: (dL, dR) => {
      const out = join.step([dL, dR]);
      tzMergeInto(view, out);
      return out;
    }
  };
}

const rows = (z: TupleZSet): Tuple[] =>
  [...z.values()]
    .filter(e => e.weight !== 0)
    .flatMap(e => Array(Math.abs(e.weight)).fill(e.t) as Tuple[]);

describe("delta join: left-outer null-extension via right-only deltas", () => {
  it("flips dangling -> matched -> dangling without touching the left side", () => {
    const { stepWith, view } = makeJoin("left");
    stepWith(tz([[1, "L"]]), emptyTupleZSet());
    expect(rows(view)).toEqual([[1, "L", null, null]]);

    stepWith(emptyTupleZSet(), tz([[1, "R"]]));
    expect(rows(view)).toEqual([[1, "L", 1, "R"]]);

    stepWith(emptyTupleZSet(), tz([[1, "R"]], -1));
    expect(rows(view)).toEqual([[1, "L", null, null]]);
  });

  it("keeps counters per left ROW when a residual splits the key", () => {
    const residual = (t: Tuple): boolean =>
      compareClassValues(t[1], t[4], "number") < 0;
    const { stepWith, view } = makeJoin("left", { residual });
    stepWith(
      tz([
        [1, 5, "low"],
        [1, 50, "high"]
      ]),
      emptyTupleZSet()
    );
    expect(rows(view)).toHaveLength(2);

    stepWith(emptyTupleZSet(), tz([[1, 10]]));
    const v1 = rows(view);
    expect(v1).toContainEqual([1, 5, "low", 1, 10]);
    expect(v1).toContainEqual([1, 50, "high", null, null]);
    expect(v1).toHaveLength(2);

    stepWith(emptyTupleZSet(), tz([[1, 10]], -1));
    expect(rows(view)).toEqual(
      expect.arrayContaining([
        [1, 5, "low", null, null],
        [1, 50, "high", null, null]
      ])
    );
    expect(rows(view)).toHaveLength(2);
  });

  it("simultaneous left+right deltas in one batch (ΔA⋈ΔB term)", () => {
    const { stepWith, view } = makeJoin("left");
    stepWith(tz([[1, "L"]]), tz([[1, "R"]]));
    expect(rows(view)).toEqual([[1, "L", 1, "R"]]);

    stepWith(tz([[1, "L"]], -1), tz([[1, "R"]], -1));
    expect(rows(view)).toEqual([]);
  });

  it("re-appearing left row recomputes its counter against current right state", () => {
    const { stepWith, view } = makeJoin("left");
    stepWith(tz([[1, "L"]]), tz([[1, "R"]]));
    stepWith(tz([[1, "L"]], -1), emptyTupleZSet());
    stepWith(emptyTupleZSet(), tz([[1, "R"]], -1));
    stepWith(tz([[1, "L"]]), emptyTupleZSet());
    expect(rows(view)).toEqual([[1, "L", null, null]]);
  });
});

describe("delta join: weights and null keys", () => {
  it("multiplies weights (duplicate rows)", () => {
    const { stepWith, view } = makeJoin("inner");
    stepWith(tz([[1, "L"]], 2), tz([[1, "R"]], 3));
    const k = tupleKey([1, "L", 1, "R"]);
    expect(view.get(k)?.weight).toBe(6);
    stepWith(emptyTupleZSet(), tz([[1, "R"]], -2));
    expect(view.get(k)?.weight).toBe(2);
  });

  it("null join keys never match; left join null-extends them statelessly", () => {
    const inner = makeJoin("inner");
    inner.stepWith(tz([[null, "L"]]), tz([[null, "R"]]));
    expect(rows(inner.view)).toEqual([]);

    const left = makeJoin("left");
    left.stepWith(tz([[null, "L"]]), tz([[null, "R"]]));
    expect(rows(left.view)).toEqual([[null, "L", null, null]]);
    left.stepWith(tz([[null, "L"]], -1), emptyTupleZSet());
    expect(rows(left.view)).toEqual([]);
  });
});
