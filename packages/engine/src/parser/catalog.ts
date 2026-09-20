export class SchemaCatalog {
  private readonly keyCols = new Map<string, string[]>();
  private readonly uniqueCols = new Map<string, string[][]>();
  private readonly colTypes = new Map<string, Record<string, string>>();

  setKeyColumns(table: string, columns: string[]): void {
    if (columns.length > 0) this.keyCols.set(table, columns);
  }

  setUniqueKeys(table: string, keys: string[][]): void {
    if (keys.length > 0) this.uniqueCols.set(table, keys);
  }

  setColumnTypes(table: string, types: Record<string, string>): void {
    this.colTypes.set(table, types);
  }

  keyColumnsOf(table: string): string[] {
    return this.keyCols.get(table) ?? [];
  }

  keysOf(table: string): string[][] {
    const pk = this.keyColumnsOf(table);
    const unique = this.uniqueCols.get(table) ?? [];
    return pk.length > 0 ? [pk, ...unique] : unique;
  }

  typeOf(table: string, column: string): string | undefined {
    return this.colTypes.get(table)?.[column];
  }

  columnsOf(table: string): readonly string[] | undefined {
    const types = this.colTypes.get(table);
    return types && Object.keys(types);
  }
}
