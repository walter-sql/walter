import {
  UnsupportedSqlError,
  collectTables,
  type PgClass,
  type Query
} from "../parser/ir";
import type { SchemaCatalog } from "../parser/catalog";
import { pgClassOf } from "../parser/pgtypes";

export interface TableRef {
  name: string;
  alias: string;
}

export class PlanScope {
  readonly aliasToTable: ReadonlyMap<string, string>;

  constructor(
    readonly tables: readonly TableRef[],
    readonly catalog: SchemaCatalog
  ) {
    for (const t of tables) {
      if (!catalog.columnsOf(t.name)) {
        throw new UnsupportedSqlError(
          `table "${t.name}" is not in the catalog (no column types)`
        );
      }
    }
    this.aliasToTable = new Map(tables.map(t => [t.alias, t.name] as const));
  }

  static forQuery(query: Query, catalog: SchemaCatalog): PlanScope {
    return new PlanScope(collectTables(query.from), catalog);
  }

  typeNameOf(alias: string, column: string): string | undefined {
    const table = this.aliasToTable.get(alias);
    return table === undefined ? undefined : this.catalog.typeOf(table, column);
  }

  readonly classOf = (alias: string, column: string): PgClass | undefined =>
    pgClassOf(this.typeNameOf(alias, column));
}
