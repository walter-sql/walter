import pg from "pg";
import type { Expr, FromItem } from "../parser/ir";
import { splitQualified, UnsupportedSqlError } from "../parser/ir";
import { CAST_SQL, walterTypes } from "../parser/pgtypes";
import type { SchemaCatalog } from "../parser/catalog";
import { comparisonClass } from "../planner/types";
import { canonicalize, type Row } from "../ivm/zset";
import type {
  RowSource,
  SourcedRows,
  WindowPartition,
  WindowRequest
} from "./rowsource";
import {
  absorbedThrough,
  parseLsn,
  parseSnapshot,
  type PgSnapshot
} from "./snapshot";
import type { Stream } from "./stream";
import { wcol, type Reveal, type WindowSortKey } from "./window";

export interface PgRowSourceOptions {
  defaultSchema: string;
  catalog?: SchemaCatalog;
  stream?: Stream;
}

const MAX_BINDS = 65535;

const SNAPSHOT = "SELECT pg_current_snapshot()::text AS __snap";

const FENCE =
  "SELECT set_config('synchronous_commit', 'local', true), " +
  "pg_logical_emit_message(true, 'walter', '')::text AS lsn";

interface Statement {
  sql: string;
  values: unknown[];
}

export const SESSION_PINS =
  "SET datestyle = ISO; SET standard_conforming_strings = on; " +
  "SET TimeZone = 'UTC'; SET bytea_output = hex";

class PinnedClient extends pg.Client {
  override connect(): Promise<pg.Client>;
  override connect(
    callback: ((err: Error) => void) | ((err: null, c: pg.Client) => void)
  ): void;
  override connect(
    callback?: ((err: Error) => void) | ((err: null, c: pg.Client) => void)
  ): Promise<pg.Client> | void {
    if (!callback) {
      return super.connect().then(c => super.query(SESSION_PINS).then(() => c));
    }
    const cb = callback as (err: Error | null, c?: pg.Client) => void;
    super.connect((err: Error) => {
      if (err) return cb(err);
      super.query(SESSION_PINS).then(
        () => cb(null, this),
        e => cb(e as Error)
      );
    });
  }
}

export function pinnedPool(config: pg.PoolConfig): pg.Pool {
  const pinned: pg.PoolConfig & { Client?: typeof pg.Client } = {
    ...config,
    types: walterTypes,
    Client: PinnedClient
  };
  return new pg.Pool(pinned);
}

export class PgRowSource implements RowSource {
  private readonly defaultSchema: string;
  private readonly catalog?: SchemaCatalog;
  private readonly stream?: Stream;
  private probing = false;

  constructor(
    private readonly pool: pg.Pool,
    opts: PgRowSourceOptions
  ) {
    this.defaultSchema = opts.defaultSchema;
    this.catalog = opts.catalog;
    this.stream = opts.stream;
    if (this.stream) {
      this.stream.onBacklog = () => this.probe();
      this.stream.issue = () => this.fence();
    }
  }

  private selectList(table: string, alias: string): string {
    const cols = this.catalog?.columnsOf(table);
    return cols
      ? cols.map(c => `${alias}.${ident(c)}`).join(", ")
      : `${alias}.*`;
  }

  async scopedRows(
    table: string,
    predicate: Expr | undefined,
    params: readonly unknown[]
  ): Promise<SourcedRows> {
    const values: unknown[] = [];
    const bind = (v: unknown) => `$${values.push(v)}`;
    const where = predicate
      ? ` WHERE ${exprToSql(predicate, params, bind)}`
      : "";
    const sql = `SELECT ${this.selectList(table, "x")} FROM ${this.rel(table)} x${where}`;
    return this.run([{ sql, values }]);
  }

  async fetchWhereIn(
    table: string,
    columns: readonly string[],
    keys: readonly (readonly unknown[])[]
  ): Promise<SourcedRows> {
    if (keys.length === 0) return { snap: absorbedThrough(0), rows: [] };
    const rel = this.rel(table);
    if (columns.length === 1) {
      const sql = `SELECT ${this.selectList(table, "x")} FROM ${rel} x WHERE x.${ident(
        columns[0]!
      )} = ANY($1)`;
      return this.run([{ sql, values: [keys.map(k => k[0])] }]);
    }
    // Row-IN overflows PG's max_stack_depth around ~32k tuples.
    const cap = Math.floor(MAX_BINDS / columns.length);
    const chunks: Statement[] = [];
    for (let at = 0; at < keys.length; at += cap) {
      const values: unknown[] = [];
      const bind = (v: unknown) => `$${values.push(v)}`;
      const terms = keys
        .slice(at, at + cap)
        .map(
          k =>
            `(${columns.map((c, j) => `x.${ident(c)} = ${bind(k[j])}`).join(" AND ")})`
        )
        .join(" OR ");
      chunks.push({
        sql: `SELECT ${this.selectList(table, "x")} FROM ${rel} x WHERE ${terms}`,
        values
      });
    }
    return this.run(chunks);
  }

  async fetchWindow(req: WindowRequest): Promise<SourcedRows> {
    if (req.partitions.length === 0)
      return { snap: absorbedThrough(0), rows: [] };
    const select = [
      this.selectList(req.anchorTable, ident(req.anchorAlias)),
      ...req.order.flatMap((k, i) =>
        k.anchor ? [] : [`${sortKeyCol(k)} AS ${ident(wcol(i))}`]
      )
    ].join(", ");
    const fixed = () => {
      const values: unknown[] = [];
      const bind = (v: unknown) => `$${values.push(v)}`;
      const pred = req.fetch.where
        ? exprToSql(req.fetch.where, req.params, bind, true)
        : undefined;
      const from = this.fromSql(req.fetch.from, req.params, bind);
      return { values, bind, pred, from };
    };

    const a = ident(req.anchorAlias);
    const cols = req.correlationColumns;
    if (req.reveal !== undefined) {
      return this.windowRead(req, parts => {
        const { values, bind, pred, from } = fixed();
        const preTerms = values.length;
        const terms = parts.map(p => {
          const conds = cols.map(
            (c, i) => `${a}.${ident(c)} = ${bind(p.value[i])}`
          );
          if (p.after) {
            conds.push(`NOT ${keysetAfterSql(req.order, p.after, bind)}`);
          }
          return conds.length > 0 ? `(${conds.join(" AND ")})` : "TRUE";
        });
        const partBinds = values.length - preTerms;
        const conds = [
          pred,
          `(${terms.join(" OR ")})`,
          revealSql(req.reveal!, bind)
        ]
          .filter((c): c is string => !!c)
          .join(" AND ");
        return {
          sql: `SELECT ${select} FROM ${from} WHERE ${conds}`,
          values,
          fixedBinds: values.length - partBinds
        };
      });
    }

    if (cols.length === 0) {
      const { values, bind, pred, from } = fixed();
      const after = req.partitions[0]!.after;
      const conds = [
        pred,
        after ? keysetAfterSql(req.order, after, bind) : undefined
      ]
        .filter((c): c is string => !!c)
        .join(" AND ");
      const where = conds ? ` WHERE ${conds}` : "";
      const sql =
        `SELECT ${select} FROM ${from}${where} ` +
        `ORDER BY ${orderBySql(req.order)} LIMIT ${req.pageSize}`;
      return this.run([{ sql, values }]);
    }

    const partBy = cols.map(c => `${a}.${ident(c)}`).join(", ");
    const read = await this.windowRead(req, parts => {
      const { values, bind, pred, from } = fixed();
      const fixedBinds = values.length;
      const terms = parts.map(p => {
        const eq = cols
          .map((c, i) => `${a}.${ident(c)} = ${bind(p.value[i])}`)
          .join(" AND ");
        return p.after
          ? `(${eq} AND ${keysetAfterSql(req.order, p.after, bind)})`
          : `(${eq})`;
      });
      const conds = [pred, `(${terms.join(" OR ")})`]
        .filter((c): c is string => !!c)
        .join(" AND ");
      const sql =
        `SELECT r.* FROM (SELECT ${select}, row_number() OVER (` +
        `PARTITION BY ${partBy} ORDER BY ${orderBySql(req.order)}) AS __rn ` +
        `FROM ${from} WHERE ${conds}) r ` +
        `WHERE r.__rn <= ${req.pageSize}`;
      return { sql, values, fixedBinds };
    });
    for (const r of read.rows) delete r.__rn;
    return read;
  }

  private windowRead(
    req: WindowRequest,
    build: (parts: WindowPartition[]) => Statement & { fixedBinds: number }
  ): Promise<SourcedRows> {
    const whole = build(req.partitions);
    if (whole.values.length <= MAX_BINDS) return this.run([whole]);
    const perPart = req.correlationColumns.length + 2 * req.order.length - 1;
    const cap = Math.max(
      1,
      Math.floor((MAX_BINDS - whole.fixedBinds) / perPart)
    );
    const chunks: Statement[] = [];
    for (let at = 0; at < req.partitions.length; at += cap)
      chunks.push(build(req.partitions.slice(at, at + cap)));
    return this.run(chunks);
  }

  private fromSql(
    from: FromItem,
    params: readonly unknown[],
    bind: (v: unknown) => string
  ): string {
    if (from.kind === "table") {
      return `${this.rel(from.name)} ${ident(from.alias)}`;
    }
    if (from.kind === "subquery") {
      throw new UnsupportedSqlError(
        "window fetch spec cannot contain a subquery"
      );
    }
    const left = this.fromSql(from.left, params, bind);
    const right =
      from.right.kind === "join"
        ? `(${this.fromSql(from.right, params, bind)})`
        : this.fromSql(from.right, params, bind);
    const j = from.joinType === "left" ? "LEFT JOIN" : "JOIN";
    return `${left} ${j} ${right} ON ${exprToSql(from.on, params, bind, true)}`;
  }

  private rel(table: string): string {
    const { schema, name } = splitQualified(table);
    return `${ident(schema ?? this.defaultSchema)}.${ident(name)}`;
  }

  private snapshotOf(row: Row): PgSnapshot {
    const snap = parseSnapshot(row.__snap as string);
    this.stream?.settle(snap);
    return snap;
  }

  private async fence(): Promise<bigint> {
    const res = await this.pool.query(FENCE);
    return parseLsn((res.rows[0] as { lsn: string }).lsn);
  }

  private async run(statements: Statement[]): Promise<SourcedRows> {
    if (statements.length === 1) return this.read(this.pool, statements);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const got = await this.read(client, statements);
      await client.query("COMMIT");
      return got;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private async read(
    db: pg.Pool | pg.PoolClient,
    statements: Statement[]
  ): Promise<SourcedRows> {
    let snap: PgSnapshot | undefined;
    const rows: Row[] = [];
    for (const { sql, values } of statements) {
      const res = await db.query(
        `SELECT s.*, q.* FROM (${SNAPSHOT}) s LEFT JOIN LATERAL (` +
          `SELECT true AS __hit, ${sql.slice("SELECT ".length)}) q ON true`,
        values
      );
      const got = res.rows as Row[];
      snap ??= this.snapshotOf(got[0]!);
      if (got[0]!.__hit === null) continue;
      for (const row of got) {
        delete row.__snap;
        delete row.__hit;
        rows.push(row);
      }
    }
    return { snap: snap!, rows };
  }

  private probe(): void {
    if (this.probing) return;
    this.probing = true;
    this.pool
      .query(SNAPSHOT)
      .then(
        res => void this.snapshotOf(res.rows[0] as Row),
        () => {}
      )
      .finally(() => (this.probing = false));
  }
}

const BIN_OP: Record<string, string> = {
  "=": "=",
  "<>": "<>",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  like: "LIKE",
  ilike: "ILIKE"
};

export function exprToSql(
  expr: Expr,
  params: readonly unknown[],
  bind: (v: unknown) => string,
  qualify = false
): string {
  const sub = (e: Expr): string => exprToSql(e, params, bind, qualify);
  switch (expr.kind) {
    case "column":
      return qualify && expr.table !== undefined
        ? `${ident(expr.table)}.${ident(expr.name)}`
        : ident(expr.name);
    case "literal":
      return renderLiteral(expr);
    case "param":
      return bind(canonicalize(params[expr.index - 1]));
    case "neg":
      return `(-${sub(expr.operand)})`;
    case "binary": {
      const l = sub(expr.left);
      const r = sub(expr.right);
      // COLLATE "C" matches Walter's text semantics.
      const ordered =
        expr.op === "<" ||
        expr.op === "<=" ||
        expr.op === ">" ||
        expr.op === ">=";
      const textual = ordered
        ? comparisonClass(expr.left, expr.right) === "text"
        : expr.op === "ilike";
      if (textual && expr.left.ptype === "text") {
        return `(${l} COLLATE "C" ${BIN_OP[expr.op]} ${r})`;
      }
      if (textual && expr.right.ptype === "text") {
        return `(${l} ${BIN_OP[expr.op]} ${r} COLLATE "C")`;
      }
      return `(${l} ${BIN_OP[expr.op]} ${r})`;
    }
    case "and":
      return `(${expr.items.map(sub).join(" AND ")})`;
    case "or":
      return `(${expr.items.map(sub).join(" OR ")})`;
    case "not":
      return `(NOT ${sub(expr.operand)})`;
    case "isNull":
      return `(${sub(expr.operand)} IS ${expr.negated ? "NOT " : ""}NULL)`;
    case "in":
      if (expr.list.length === 0) return expr.negated ? "TRUE" : "FALSE";
      return `(${sub(expr.operand)} ${
        expr.negated ? "NOT IN" : "IN"
      } (${expr.list.map(sub).join(", ")}))`;
    case "coalesce":
      return `coalesce(${expr.args.map(sub).join(", ")})`;
    case "cast":
      return `(${sub(expr.operand)})::${CAST_SQL[expr.to]}`;
    case "func": {
      const name = expr.name;
      if (
        (name === "lower" || name === "upper") &&
        expr.args[0]?.ptype === "text"
      ) {
        return `${name}(${sub(expr.args[0])} COLLATE "C")`;
      }
      return `${name}(${expr.args.map(sub).join(", ")})`;
    }
    default:
      throw new UnsupportedSqlError(
        `cannot render predicate expression of kind ${expr.kind} to SQL`
      );
  }
}

function sortKeyCol(k: WindowSortKey): string {
  return `${ident(k.alias)}.${ident(k.column)}`;
}

function sortKeySql(k: WindowSortKey): string {
  return k.cls === "text" ? `${sortKeyCol(k)} COLLATE "C"` : sortKeyCol(k);
}

export function orderBySql(order: readonly WindowSortKey[]): string {
  return order
    .map(
      k =>
        `${sortKeySql(k)} ${k.desc ? "DESC" : "ASC"} ${
          k.nullsFirst ? "NULLS FIRST" : "NULLS LAST"
        }`
    )
    .join(", ");
}

export function keysetAfterSql(
  order: readonly WindowSortKey[],
  after: readonly unknown[],
  bind: (v: unknown) => string
): string {
  const eqs: string[] = [];
  const terms: string[] = [];

  order.forEach((k, i) => {
    const bound = after[i];
    const col = sortKeySql(k);
    const raw = sortKeyCol(k);
    let gt: string | undefined;
    if (bound === null || bound === undefined) {
      gt = k.nullsFirst ? `${raw} IS NOT NULL` : undefined;
    } else {
      const base = `${col} ${k.desc ? "<" : ">"} ${bind(bound)}`;
      gt = k.nullsFirst ? base : `(${base} OR ${raw} IS NULL)`;
    }
    if (gt) terms.push([...eqs, gt].join(" AND "));
    if (i < order.length - 1)
      eqs.push(
        bound === null || bound === undefined
          ? `${raw} IS NULL`
          : `${raw} = ${bind(bound)}`
      );
  });

  return `(${terms.map(t => `(${t})`).join(" OR ")})`;
}

function revealSql(reveal: Reveal, bind: (v: unknown) => string): string {
  const groups = reveal.map(g => {
    if (g.columns.length === 1) {
      const c = g.columns[0]!;
      const vals = g.tuples.map(t => t[0]);
      return `${ident(c.alias)}.${ident(c.column)} = ANY(${bind(vals)})`;
    }
    const cols = g.columns
      .map(c => `${ident(c.alias)}.${ident(c.column)}`)
      .join(", ");
    const tuples = g.tuples.map(t => `(${t.map(bind).join(", ")})`).join(", ");
    return `(${cols}) IN (${tuples})`;
  });
  return `(${groups.join(" OR ")})`;
}

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

function renderLiteral(e: Extract<Expr, { kind: "literal" }>): string {
  const { value } = e;
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (!e.quoted && DECIMAL_TEXT.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
