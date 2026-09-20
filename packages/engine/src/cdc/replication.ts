import { randomBytes } from "node:crypto";
import pg from "pg";
import { LogicalReplicationService } from "pg-logical-replication";
import type { SchemaCatalog } from "../parser/catalog";
import { qualifiedTable, splitQualified } from "../parser/ir";
import { ident, SESSION_PINS } from "../lazy/pg-source";
import { log } from "../util/log";
import {
  PgoutputDecoder,
  type PgoutputMessage,
  type Relation
} from "./pgoutput";
import type { ChangeOp, TxnBatch } from "./types";

const PUBLICATION = "walter_pub";

export type TxnHandler = (batch: TxnBatch) => Promise<void> | void;
export type SlotHandler = (consistentLsn: string) => void;

class TempSlotPlugin {
  readonly name = "pgoutput";
  readonly options = undefined;
  private readonly decoder = new PgoutputDecoder();

  constructor(private readonly onSlot: SlotHandler) {}

  parse(buffer: Buffer): PgoutputMessage {
    return this.decoder.decode(buffer);
  }

  async start(client: pg.Client, slotName: string): Promise<unknown> {
    // pgoutput renders tuple text with this session's GUCs.
    await client.query(SESSION_PINS);
    const created = await client.query(
      `CREATE_REPLICATION_SLOT ${ident(slotName)} TEMPORARY LOGICAL pgoutput`
    );
    const lsn = (created.rows[0] as { consistent_point: string })
      .consistent_point;
    this.onSlot(lsn);
    return client.query(
      `START_REPLICATION SLOT ${ident(slotName)} LOGICAL ${lsn} ` +
        `(proto_version '1', publication_names '${PUBLICATION}', messages 'true')`
    );
  }
}

export class CdcSource {
  private service?: LogicalReplicationService;
  private onTxn?: TxnHandler;
  private onSlot?: SlotHandler;
  private settleStart?: (lsn: string | undefined) => void;
  private reconnecting = false;
  private stopped = false;
  private lost = false;
  private lastActivity = 0;

  get degraded(): boolean {
    return this.lost;
  }

  get stats() {
    return { connected: !this.lost, lastActivity: this.lastActivity };
  }

  constructor(
    private readonly connectionString: string,
    private readonly catalog: SchemaCatalog,
    private readonly tables?: readonly string[],
    private readonly defaultSchema = "public"
  ) {}

  async setup(): Promise<void> {
    try {
      await this.doSetup();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "42710" && code !== "42704" && code !== "23505") throw e;
      await this.doSetup();
    }
  }

  private async doSetup(): Promise<void> {
    const admin = new pg.Client({ connectionString: this.connectionString });
    await admin.connect();
    try {
      await admin.query(SESSION_PINS);
      const pub = await admin.query(
        "SELECT * FROM pg_publication WHERE pubname = $1",
        [PUBLICATION]
      );
      const gencols = pub.fields.some(f => f.name === "pubgencols");
      let tables = await this.publicationTables(admin);
      if (await this.ensurePublication(admin, pub.rows[0], gencols, tables)) {
        tables = await this.publicationTables(admin);
      }
      const virtual = await admin.query(
        `SELECT DISTINCT attrelid AS oid FROM pg_attribute
          WHERE attrelid = ANY($1::oid[]) AND attgenerated = 'v'`,
        [tables.map(t => t.oid)]
      );
      if (virtual.rows.length > 0) {
        const bad = new Set(virtual.rows.map((r: { oid: number }) => r.oid));
        throw new Error(
          `table(s) ${tables
            .filter(t => bad.has(t.oid))
            .map(t => qualifiedTable(t.schema, t.name, "public"))
            .join(", ")} ` +
            `have virtual generated columns, which logical replication ` +
            `cannot deliver: drop them or scope walter to other tables`
        );
      }
      const roots = tables.filter(t => t.relkind === "p");
      if (roots.length > 0) {
        throw new Error(
          `publication ${PUBLICATION} publishes partitioned root(s) ` +
            roots
              .map(t => qualifiedTable(t.schema, t.name, "public"))
              .join(", ") +
            ` (publish_via_partition_root): recreate it publishing the leaf ` +
            `partitions instead`
        );
      }
      for (const t of tables) {
        const qname = qualifiedTable(t.schema, t.name, "public");
        const types = await this.columnTypes(admin, t.oid, gencols);
        const cols = new Set(Object.keys(types));
        const idx = await this.uniqueIndexes(admin, t.oid);
        this.catalog.setKeyColumns(
          qname,
          idx.pk.every(c => cols.has(c)) ? idx.pk : []
        );
        this.catalog.setUniqueKeys(
          qname,
          idx.unique.filter(u => u.every(c => cols.has(c)))
        );
        this.catalog.setColumnTypes(qname, types);
        // Skip when already FULL (ALTER demands ACCESS EXCLUSIVE).
        if (t.replident !== "f") {
          await admin.query(
            `ALTER TABLE ${ident(t.schema)}.${ident(t.name)} REPLICA IDENTITY FULL`
          );
        }
      }
    } finally {
      await admin.end();
    }
  }

  async start(
    onTxn: TxnHandler,
    onSlot: SlotHandler
  ): Promise<string | undefined> {
    this.onTxn = onTxn;
    return new Promise(resolve => {
      this.settleStart = resolve;
      this.onSlot = lsn => {
        this.lost = false;
        onSlot(lsn);
        this.settle(lsn);
      };
      void this.connectStream();
    });
  }

  private settle(lsn: string | undefined): void {
    this.settleStart?.(lsn);
    this.settleStart = undefined;
  }

  private async connectStream(): Promise<void> {
    const service = new LogicalReplicationService(
      { connectionString: this.connectionString },
      {
        acknowledge: { auto: true, timeoutSeconds: 10 },
        flowControl: { enabled: true }
      }
    );
    const slotName = `walter_${randomBytes(6).toString("hex")}`;
    this.service = service;
    const plugin = new TempSlotPlugin(lsn => {
      this.lastActivity = Date.now();
      log.info({ slot: slotName, lsn }, "replication slot created");
      this.onSlot?.(lsn);
    });

    let xid = 0;
    let ops: ChangeOp[] = [];
    let truncated: string[] = [];
    service.on("data", async (_lsn: string, msg: PgoutputMessage) => {
      this.lastActivity = Date.now();
      switch (msg.tag) {
        case "begin":
          xid = msg.xid;
          ops = [];
          truncated = [];
          break;
        case "insert":
          ops.push({
            table: relationName(msg.relation),
            xid,
            kind: "insert",
            newRow: msg.new
          });
          break;
        case "update":
          ops.push({
            table: relationName(msg.relation),
            xid,
            kind: "update",
            newRow: msg.new,
            oldRow: msg.old
          });
          break;
        case "delete":
          ops.push({
            table: relationName(msg.relation),
            xid,
            kind: "delete",
            oldRow: msg.old
          });
          break;
        case "truncate":
          for (const rel of msg.relations) truncated.push(relationName(rel));
          break;
        case "commit": {
          const batch: TxnBatch = { xid, position: msg.end, ops };
          if (truncated.length > 0) batch.truncated = truncated;
          ops = [];
          truncated = [];
          await this.onTxn?.(batch);
          break;
        }
      }
    });
    service.on(
      "heartbeat",
      async (lsn: string, _ts: number, shouldRespond: boolean) => {
        this.lastActivity = Date.now();
        if (shouldRespond) await service.acknowledge(lsn).catch(() => {});
      }
    );
    service.on("error", (err: Error) => {
      log.error({ err }, "replication error");
      this.scheduleReconnect();
    });

    service.subscribe(plugin, slotName).catch((err: Error) => {
      log.error({ err }, "replication subscribe failed");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    this.lost = true;
    this.settle(undefined);
    setTimeout(async () => {
      try {
        await this.service?.stop();
      } catch {}
      this.reconnecting = false;
      if (!this.stopped) {
        log.warn("replication stream lost; reconnecting with a fresh slot");
        await this.connectStream().catch(e => {
          log.error({ err: e as Error }, "replication reconnect failed");
          this.scheduleReconnect();
        });
      }
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.service?.stop();
  }

  private async ensurePublication(
    admin: pg.Client,
    existing: { puballtables: boolean; pubgencols?: string } | undefined,
    gencols: boolean,
    live: { schema: string; name: string }[]
  ): Promise<boolean> {
    const cfg = this.tables?.length
      ? this.tables.map(t => {
          const { schema, name } = splitQualified(t);
          return { schema: schema ?? this.defaultSchema, name };
        })
      : undefined;
    const forTable = cfg
      ?.map(t => `${ident(t.schema)}.${ident(t.name)}`)
      .join(", ");
    const create =
      `CREATE PUBLICATION ${ident(PUBLICATION)} ` +
      (forTable ? `FOR TABLE ${forTable}` : "FOR ALL TABLES") +
      (gencols ? " WITH (publish_generated_columns = stored)" : "");
    if (!existing) {
      await admin.query(create);
      return true;
    }
    if (existing.puballtables !== !cfg) {
      await admin.query(`DROP PUBLICATION ${ident(PUBLICATION)}`);
      await admin.query(create);
      return true;
    }
    if (gencols && existing.pubgencols !== "s") {
      await admin.query(
        `ALTER PUBLICATION ${ident(PUBLICATION)} ` +
          `SET (publish_generated_columns = stored)`
      );
    }
    if (cfg) {
      const have = new Set(
        live.map(t => qualifiedTable(t.schema, t.name, "public"))
      );
      if (
        cfg.length !== have.size ||
        cfg.some(t => !have.has(qualifiedTable(t.schema, t.name, "public")))
      ) {
        await admin.query(
          `ALTER PUBLICATION ${ident(PUBLICATION)} SET TABLE ${forTable}`
        );
        return true;
      }
    }
    return false;
  }

  private async publicationTables(admin: pg.Client): Promise<
    {
      oid: number;
      schema: string;
      name: string;
      replident: string;
      relkind: string;
    }[]
  > {
    const res = await admin.query(
      `SELECT c.oid, p.schemaname, p.tablename, c.relreplident, c.relkind
         FROM pg_publication_tables p
         JOIN pg_namespace n ON n.nspname = p.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = p.tablename
        WHERE p.pubname = $1`,
      [PUBLICATION]
    );
    const rows = res.rows as {
      oid: number;
      schemaname: string;
      tablename: string;
      relreplident: string;
      relkind: string;
    }[];
    return rows.map(r => ({
      oid: r.oid,
      schema: r.schemaname,
      name: r.tablename,
      replident: r.relreplident,
      relkind: r.relkind
    }));
  }

  private async uniqueIndexes(
    admin: pg.Client,
    oid: number
  ): Promise<{ pk: string[]; unique: string[][] }> {
    const res = await admin.query(
      // ::text so the driver parses cols as an array (it has no name[] parser).
      `SELECT i.indisprimary AS is_pk,
              array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum)) AS cols
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid
          AND a.attnum = ANY(i.indkey[0:i.indnkeyatts-1])
        WHERE i.indrelid = $1
          AND i.indisunique AND i.indisvalid
          AND i.indpred IS NULL AND i.indexprs IS NULL
        GROUP BY i.indexrelid, i.indisprimary`,
      [oid]
    );
    const rows = res.rows as { is_pk: boolean; cols: string[] }[];
    return {
      pk: rows.find(r => r.is_pk)?.cols ?? [],
      unique: rows.filter(r => !r.is_pk).map(r => r.cols)
    };
  }

  private async columnTypes(
    admin: pg.Client,
    oid: number,
    gencols: boolean
  ): Promise<Record<string, string>> {
    const res = await admin.query(
      `SELECT a.attname AS name, t.typname AS type
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = $1
          AND a.attnum > 0 AND NOT a.attisdropped
          AND (a.attgenerated = '' OR (a.attgenerated = 's' AND $2))
        ORDER BY a.attnum`,
      [oid, gencols]
    );
    const out: Record<string, string> = {};
    for (const r of res.rows as { name: string; type: string }[]) {
      out[r.name] = r.type;
    }
    return out;
  }
}

function relationName(rel: Relation): string {
  return qualifiedTable(rel.schema, rel.name, "public");
}
