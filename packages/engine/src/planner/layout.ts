import { UnsupportedSqlError } from "../parser/ir";

export interface Slot {
  alias?: string;
  name: string;
}

export class Layout {
  private readonly byQualified = new Map<string, number>();
  private readonly byName = new Map<string, number[]>();

  constructor(readonly slots: readonly Slot[]) {
    slots.forEach((s, i) => {
      if (s.alias !== undefined)
        this.byQualified.set(`${s.alias}.${s.name}`, i);
      let list = this.byName.get(s.name);
      if (!list) this.byName.set(s.name, (list = []));
      list.push(i);
    });
  }

  get arity(): number {
    return this.slots.length;
  }

  static forSource(alias: string, columns: readonly string[]): Layout {
    return new Layout(columns.map(name => ({ alias, name })));
  }

  static synthetic(names: readonly string[]): Layout {
    return new Layout(names.map(name => ({ name })));
  }

  concat(right: Layout): Layout {
    return new Layout([...this.slots, ...right.slots]);
  }

  resolve(alias: string | undefined, name: string): number {
    if (alias !== undefined) {
      const idx = this.byQualified.get(`${alias}.${name}`);
      if (idx === undefined) {
        throw new UnsupportedSqlError(`column ${alias}.${name} does not exist`);
      }
      return idx;
    }
    const list = this.byName.get(name);
    if (!list || list.length === 0) {
      throw new UnsupportedSqlError(`column "${name}" does not exist`);
    }
    if (list.length > 1) {
      throw new UnsupportedSqlError(`column reference "${name}" is ambiguous`);
    }
    return list[0]!;
  }
}
