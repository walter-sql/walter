import { walterTypes } from "../parser/pgtypes";
import type { Row } from "../ivm/zset";

export interface Relation {
  schema: string;
  name: string;
  columns: { name: string; parse: (text: string) => unknown }[];
}

export type PgoutputMessage =
  | { tag: "begin"; xid: number }
  | { tag: "commit"; end: bigint }
  | { tag: "insert"; relation: Relation; new: Row }
  | { tag: "update"; relation: Relation; old: Row; new: Row }
  | { tag: "delete"; relation: Relation; old: Row }
  | { tag: "truncate"; relations: Relation[] }
  | { tag: "other" };

class Reader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}

  u8(): number {
    return this.buf.readUInt8(this.at++);
  }
  i16(): number {
    const v = this.buf.readInt16BE(this.at);
    this.at += 2;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32BE(this.at);
    this.at += 4;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64BE(this.at);
    this.at += 8;
    return v;
  }
  skip(n: number): void {
    this.at += n;
  }
  cstring(): string {
    const end = this.buf.indexOf(0, this.at);
    if (end < 0) throw new Error("pgoutput: unterminated string");
    const s = this.buf.toString("utf8", this.at, end);
    this.at = end + 1;
    return s;
  }
  text(n: number): string {
    const s = this.buf.toString("utf8", this.at, this.at + n);
    this.at += n;
    return s;
  }
}

export class PgoutputDecoder {
  private readonly relations = new Map<number, Relation>();

  decode(buf: Buffer): PgoutputMessage {
    const r = new Reader(buf);
    switch (String.fromCharCode(r.u8())) {
      case "B":
        r.skip(16);
        return { tag: "begin", xid: r.i32() };
      case "C":
        r.skip(9);
        return { tag: "commit", end: r.u64() };
      case "R":
        return this.relation(r);
      case "I": {
        const relation = this.relationOf(r);
        r.u8();
        return { tag: "insert", relation, new: this.tuple(r, relation) };
      }
      case "U": {
        const relation = this.relationOf(r);
        const old = this.oldTuple(r, relation);
        r.u8();
        return {
          tag: "update",
          relation,
          old,
          new: this.tuple(r, relation, old)
        };
      }
      case "D": {
        const relation = this.relationOf(r);
        return { tag: "delete", relation, old: this.oldTuple(r, relation) };
      }
      case "T": {
        const n = r.i32();
        r.u8();
        const relations: Relation[] = [];
        for (let i = 0; i < n; i++) relations.push(this.relationOf(r));
        return { tag: "truncate", relations };
      }
      default:
        return { tag: "other" };
    }
  }

  private relation(r: Reader): PgoutputMessage {
    const id = r.i32();
    const schema = r.cstring();
    const name = r.cstring();
    r.u8();
    const n = r.i16();
    const columns: Relation["columns"] = [];
    for (let i = 0; i < n; i++) {
      r.u8();
      const colName = r.cstring();
      const parse = walterTypes.getTypeParser(r.i32());
      r.i32();
      columns.push({ name: colName, parse });
    }
    this.relations.set(id, { schema, name, columns });
    return { tag: "other" };
  }

  private relationOf(r: Reader): Relation {
    const id = r.i32();
    const rel = this.relations.get(id);
    if (!rel) throw new Error(`pgoutput: unknown relation ${id}`);
    return rel;
  }

  private oldTuple(r: Reader, relation: Relation): Row {
    if (String.fromCharCode(r.u8()) !== "O") {
      throw new Error(
        `pgoutput: ${relation.schema}.${relation.name} streams key-only old rows; REPLICA IDENTITY FULL is required`
      );
    }
    return this.tuple(r, relation);
  }

  private tuple(r: Reader, relation: Relation, old?: Row): Row {
    const n = r.i16();
    const row: Row = {};
    for (let i = 0; i < n; i++) {
      const { name, parse } = relation.columns[i]!;
      switch (String.fromCharCode(r.u8())) {
        case "n":
          row[name] = null;
          break;
        case "t":
          row[name] = parse(r.text(r.i32()));
          break;
        case "u":
          if (!old)
            throw new Error("pgoutput: unchanged TOAST without an old row");
          row[name] = old[name];
          break;
        default:
          throw new Error("pgoutput: binary tuple data is not requested");
      }
    }
    return row;
  }
}
