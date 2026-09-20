import { describe, it, expect } from "vitest";
import { PgoutputDecoder } from "../src/cdc/pgoutput";

const str = (s: string) =>
  Buffer.concat([Buffer.from(s, "utf8"), Buffer.of(0)]);
const i8 = (n: number) => Buffer.of(n);
const i16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const tag = (c: string) => Buffer.from(c, "ascii");
const msg = (...parts: Buffer[]) => Buffer.concat(parts);

function tuple(values: (string | null | { u: true })[]): Buffer {
  return msg(
    i16(values.length),
    ...values.map(v =>
      v === null
        ? tag("n")
        : typeof v === "object"
          ? tag("u")
          : msg(tag("t"), i32(Buffer.byteLength(v)), Buffer.from(v))
    )
  );
}

function relation(id: number, columns: [string, number][]): Buffer {
  return msg(
    tag("R"),
    i32(id),
    str("public"),
    str("t"),
    i8(0x66),
    i16(columns.length),
    ...columns.map(([name, oid]) => msg(i8(0), str(name), i32(oid), i32(-1)))
  );
}

const REL = relation(7, [
  ["id", 20],
  ["n", 23],
  ["f", 700],
  ["at", 1114],
  ["body", 25]
]);

describe("pgoutput decoder", () => {
  it("decodes rows through Walter's type parsers, not pg's defaults", () => {
    const d = new PgoutputDecoder();
    expect(d.decode(REL)).toEqual({ tag: "other" });
    expect(d.decode(msg(tag("B"), Buffer.alloc(16), i32(4242)))).toEqual({
      tag: "begin",
      xid: 4242
    });
    const ins = d.decode(
      msg(
        tag("I"),
        i32(7),
        tag("N"),
        tuple(["5", "5", "0.1", "2024-01-02 03:04:05.123456", null])
      )
    );
    expect(ins).toMatchObject({
      tag: "insert",
      new: {
        id: "5",
        n: 5,
        f: Math.fround(0.1),
        at: "2024-01-02 03:04:05.123456",
        body: null
      }
    });
    const commit = Buffer.alloc(25);
    commit.writeBigUInt64BE(0x16b374d848n, 9);
    expect(d.decode(msg(tag("C"), commit))).toEqual({
      tag: "commit",
      end: 0x16b374d848n
    });
  });

  it("fills unchanged TOAST columns from the full old image", () => {
    const d = new PgoutputDecoder();
    d.decode(REL);
    const upd = d.decode(
      msg(
        tag("U"),
        i32(7),
        tag("O"),
        tuple(["1", "1", "1", "x", "big"]),
        tag("N"),
        tuple(["1", "2", "1", "x", { u: true }])
      )
    );
    expect(upd).toMatchObject({
      tag: "update",
      old: { n: 1, body: "big" },
      new: { n: 2, body: "big" }
    });
    const del = d.decode(
      msg(tag("D"), i32(7), tag("O"), tuple(["1", "1", "1", "x", "big"]))
    );
    expect(del).toMatchObject({ tag: "delete", old: { id: "1" } });
    expect(d.decode(msg(tag("T"), i32(1), i8(0), i32(7)))).toMatchObject({
      tag: "truncate",
      relations: [{ name: "t" }]
    });
  });

  it("refuses key-only old images and unknown relations loudly", () => {
    const d = new PgoutputDecoder();
    d.decode(REL);
    expect(() =>
      d.decode(
        msg(tag("D"), i32(7), tag("K"), tuple(["1", null, null, null, null]))
      )
    ).toThrow(/REPLICA IDENTITY FULL/);
    expect(() => d.decode(msg(tag("I"), i32(8), tag("N"), tuple([])))).toThrow(
      /unknown relation 8/
    );
  });
});
