import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { CdcSource } from "../src/cdc/replication";
import { SchemaCatalog } from "../src/parser/catalog";
import { PgRowSource, pinnedPool } from "../src/lazy/pg-source";
import type { Expr } from "../src/parser/ir";
import type { TxnBatch } from "../src/cdc/types";
import { ownDatabase, startCdc } from "./pg";

const CONN = ownDatabase("cdc_setup");

describe.skipIf(!CONN)("CdcSource.setup() catalog bootstrap", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: CONN });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "MySchema" CASCADE`);
    await client.query(`CREATE SCHEMA "MySchema"`);
    await client.query(
      `CREATE TABLE "MySchema"."MyTable" (
         "MyId" int PRIMARY KEY,
         body text,
         "Alt" text UNIQUE
       )`
    );
    await client.query(
      `CREATE TABLE "MySchema"."Covering" (
         id int,
         a int,
         email text,
         note text,
         PRIMARY KEY (id) INCLUDE (a)
       )`
    );
    await client.query(
      `CREATE UNIQUE INDEX covering_email
         ON "MySchema"."Covering" (email) INCLUDE (note)`
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "MySchema" CASCADE`);
    await client.end();
  });

  it("bootstraps a mixed-case schema/table/column", async () => {
    const catalog = new SchemaCatalog();
    await new CdcSource(CONN!, catalog).setup();
    const t = '"MySchema"."MyTable"';
    expect(catalog.keysOf(t)).toEqual([["MyId"], ["Alt"]]);
    expect(catalog.columnsOf(t)).toEqual(["MyId", "body", "Alt"]);
    expect(catalog.typeOf(t, "MyId")).toBe("int4");
    expect(catalog.typeOf(t, "Alt")).toBe("text");
    const identity = await client.query(
      `SELECT relreplident FROM pg_class
        WHERE oid = '"MySchema"."MyTable"'::regclass`
    );
    expect(identity.rows[0].relreplident).toBe("f");
  });

  it("keys and witnesses carry key columns only, never INCLUDE payload", async () => {
    const catalog = new SchemaCatalog();
    await new CdcSource(CONN!, catalog).setup();
    expect(catalog.keysOf('"MySchema"."Covering"')).toEqual([
      ["id"],
      ["email"]
    ]);
  });
});

describe.skipIf(!CONN)("CdcSource.setup() grant-less boot", () => {
  const dbUrl = ownDatabase("replident_probe")!;
  const ROLE = "walter_probe_ro";
  let owner: pg.Client; // owns the probe tables
  let roleUrl: string;

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: dbUrl });
    await owner.connect();
    await owner.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await owner.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}'`);
    await owner.query(`CREATE TABLE ready (id int PRIMARY KEY, body text)`);
    await owner.query(`ALTER TABLE ready REPLICA IDENTITY FULL`);
    await owner.query(
      `CREATE PUBLICATION walter_pub FOR ALL TABLES
         WITH (publish_generated_columns = stored)`
    );

    const url = new URL(dbUrl);
    url.username = ROLE;
    url.password = ROLE;
    roleUrl = url.href;
  });

  afterAll(async () => {
    await owner.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await owner.end();
  });

  it("boots as a non-owner when identities are pre-provisioned", async () => {
    const catalog = new SchemaCatalog();
    await new CdcSource(roleUrl, catalog).setup();
    expect(catalog.keyColumnsOf("public.ready")).toEqual(["id"]);
  });

  it("still fails loudly on a table not yet FULL", async () => {
    await owner.query(`CREATE TABLE unready (id int PRIMARY KEY)`);
    try {
      await expect(
        new CdcSource(roleUrl, new SchemaCatalog()).setup()
      ).rejects.toThrow(/must be owner/);
    } finally {
      await owner.query(`DROP TABLE unready`);
    }
  });
});

describe.skipIf(!CONN)("CdcSource.setup() partitioned tables", () => {
  const dbUrl = ownDatabase("partition_probe")!;
  let db: pg.Client;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(
      `CREATE TABLE m (id int, day date, v text, PRIMARY KEY (id, day))
         PARTITION BY RANGE (day)`
    );
    await db.query(
      `CREATE TABLE m_a PARTITION OF m
         FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')`
    );
  });

  afterAll(async () => {
    await db.end();
  });

  it("boots leaves under a default publication; the root is no table", async () => {
    await db.query(`CREATE PUBLICATION walter_pub FOR ALL TABLES`);
    try {
      const catalog = new SchemaCatalog();
      await new CdcSource(dbUrl, catalog).setup();
      expect(catalog.keyColumnsOf("public.m_a")).toEqual(["id", "day"]);
      expect(catalog.columnsOf("public.m")).toBeUndefined();
      const ri = await db.query(
        `SELECT relreplident FROM pg_class WHERE relname = 'm_a'`
      );
      expect(ri.rows[0].relreplident).toBe("f");
    } finally {
      await db.query(`DROP PUBLICATION walter_pub`);
    }
  });

  it("rejects a publish_via_partition_root publication loudly", async () => {
    await db.query(
      `CREATE PUBLICATION walter_pub FOR ALL TABLES
         WITH (publish_via_partition_root = true)`
    );
    try {
      await expect(
        new CdcSource(dbUrl, new SchemaCatalog()).setup()
      ).rejects.toThrow(/partitioned root/);
    } finally {
      await db.query(`DROP PUBLICATION walter_pub`);
    }
  });
});

describe.skipIf(!CONN)(
  "session GUC pins survive hostile server defaults",
  () => {
    const dbUrl = ownDatabase("pins_probe")!;
    let db: pg.Client;
    let pool: pg.Pool;

    beforeAll(async () => {
      db = new pg.Client({ connectionString: dbUrl });
      await db.connect();
      const DB = new URL(dbUrl).pathname.slice(1);
      await db.query(`ALTER DATABASE ${DB} SET datestyle = 'German, DMY'`);
      await db.query(`ALTER DATABASE ${DB} SET timezone = 'Asia/Kolkata'`);
      await db.query(
        `ALTER DATABASE ${DB} SET standard_conforming_strings = off`
      );
      await db.query(
        `CREATE TABLE t (id int PRIMARY KEY, d date, body text, tz timestamptz)`
      );
      await db.query(
        `INSERT INTO t VALUES (1, '2024-01-15', $1, '2024-01-15 12:00:00.123456+00')`,
        ["a\\b"]
      );
      pool = pinnedPool({ connectionString: dbUrl, max: 2 });
    });

    afterAll(async () => {
      await pool?.end();
      await db.end();
    });

    it("seed reads return ISO date text and match backslash literals", async () => {
      const src = new PgRowSource(pool, { defaultSchema: "public" });
      const all = await src.scopedRows("public.t", undefined, []);
      expect(all.rows[0]!.d).toBe("2024-01-15");
      expect(all.rows[0]!.tz).toBe("2024-01-15 12:00:00.123456+00");
      const eq: Expr = {
        kind: "binary",
        op: "=",
        left: { kind: "column", name: "body" },
        right: { kind: "literal", value: "a\\b" }
      };
      const hit = await src.scopedRows("public.t", eq, []);
      expect(hit.rows.map(r => r.id)).toEqual([1]);
    });

    it("WAL rows carry ISO date text", async () => {
      const cdc = new CdcSource(dbUrl, new SchemaCatalog());
      const batches: TxnBatch[] = [];
      await cdc.setup();
      await startCdc(cdc, b => {
        batches.push(b);
      });
      try {
        await db.query(
          `INSERT INTO t VALUES (2, '2024-02-20', 'x', '2024-02-20 08:00:00.000042+00')`
        );
        const op = () =>
          batches.flatMap(b => b.ops).find(o => o.newRow?.id === 2);
        const deadline = Date.now() + 10_000;
        while (!op()) {
          if (Date.now() > deadline)
            throw new Error("timed out waiting for WAL");
          await new Promise(r => setTimeout(r, 25));
        }
        expect(op()!.newRow!.d).toBe("2024-02-20");
        expect(op()!.newRow!.tz).toBe("2024-02-20 08:00:00.000042+00");
      } finally {
        await cdc.stop();
      }
    }, 20000);
  }
);

describe.skipIf(!CONN)("CdcSource.setup() generated columns", () => {
  const dbUrl = ownDatabase("gencol_probe")!;
  let db: pg.Client;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(
      `CREATE TABLE gen (
         id int PRIMARY KEY,
         qty int NOT NULL,
         price int NOT NULL,
         total int GENERATED ALWAYS AS (qty * price) STORED,
         note text
       )`
    );
    await db.query(`CREATE UNIQUE INDEX gen_total ON gen (total)`);
    await db.query(
      `CREATE TABLE genpk (
         a int UNIQUE NOT NULL,
         b int GENERATED ALWAYS AS (a + 1) STORED PRIMARY KEY
       )`
    );
    await db.query(`INSERT INTO gen VALUES (1, 2, 10, DEFAULT, 'x')`);
  });

  afterAll(async () => {
    await db.end();
  });

  it("serves stored generated columns, witnesses included (PG 18)", async () => {
    const catalog = new SchemaCatalog();
    await new CdcSource(dbUrl, catalog).setup();
    expect(catalog.columnsOf("public.gen")).toEqual([
      "id",
      "qty",
      "price",
      "total",
      "note"
    ]);
    expect(catalog.keysOf("public.gen")).toEqual([["id"], ["total"]]);
    expect(catalog.keysOf("public.genpk")).toEqual([["b"], ["a"]]);
  });

  it("refuses a table with a virtual generated column", async () => {
    await db.query(
      `CREATE TABLE vt (id int PRIMARY KEY,
         v int GENERATED ALWAYS AS (id + 1) VIRTUAL)`
    );
    try {
      await expect(
        new CdcSource(dbUrl, new SchemaCatalog()).setup()
      ).rejects.toThrow(/virtual generated/);
    } finally {
      await db.query(`DROP TABLE vt`);
    }
  });

  it("seed rows and WAL rows carry the same column set", async () => {
    const catalog = new SchemaCatalog();
    const cdc = new CdcSource(dbUrl, catalog);
    const batches: TxnBatch[] = [];
    await cdc.setup();
    const pool = pinnedPool({ connectionString: dbUrl, max: 2 });
    const src = new PgRowSource(pool, { defaultSchema: "public", catalog });
    try {
      const seed = await src.scopedRows("public.gen", undefined, []);
      const seedKeys = Object.keys(seed.rows[0]!).sort();
      expect(seedKeys).toEqual(["id", "note", "price", "qty", "total"]);

      await startCdc(cdc, b => {
        batches.push(b);
      });
      await db.query(`UPDATE gen SET qty = 3 WHERE id = 1`);
      const op = () =>
        batches.flatMap(b => b.ops).find(o => o.kind === "update");
      const deadline = Date.now() + 10_000;
      while (!op()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for WAL");
        await new Promise(r => setTimeout(r, 25));
      }
      expect(Object.keys(op()!.newRow!).sort()).toEqual(seedKeys);
      expect(Object.keys(op()!.oldRow!).sort()).toEqual(seedKeys);
      expect(Number(op()!.newRow!.total)).toBe(30);
    } finally {
      await cdc.stop();
      await pool.end();
    }
  }, 20000);
});

describe.skipIf(!CONN)("CdcSource.setup() table scoping", () => {
  const dbUrl = ownDatabase("scope_probe")!;
  let db: pg.Client;

  const published = async () =>
    (
      await db.query(
        `SELECT schemaname || '.' || tablename AS t
           FROM pg_publication_tables WHERE pubname = 'walter_pub' ORDER BY 1`
      )
    ).rows.map((r: { t: string }) => r.t);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(`CREATE TABLE a (id int PRIMARY KEY)`);
    await db.query(`CREATE TABLE b (id int PRIMARY KEY)`);
  });

  afterAll(async () => {
    await db.end();
  });

  it("publishes exactly the configured tables", async () => {
    const catalog = new SchemaCatalog();
    await new CdcSource(dbUrl, catalog, ["a"]).setup();
    expect(await published()).toEqual(["public.a"]);
    expect(catalog.columnsOf("public.a")).toBeDefined();
    expect(catalog.columnsOf("public.b")).toBeUndefined();
    const ri = await db.query(
      `SELECT relname, relreplident FROM pg_class
        WHERE relname IN ('a', 'b') ORDER BY relname`
    );
    expect(ri.rows).toEqual([
      { relname: "a", relreplident: "f" },
      { relname: "b", relreplident: "d" }
    ]);
  });

  it("re-boot with the same config is a pure read", async () => {
    const relOids = async () =>
      (
        await db.query(`SELECT oid FROM pg_publication_rel ORDER BY oid`)
      ).rows.map((r: { oid: unknown }) => r.oid);
    const before = await relOids();
    await new CdcSource(dbUrl, new SchemaCatalog(), ["public.a"]).setup();
    expect(await relOids()).toEqual(before);
  });

  it("a config change updates the list without recreating", async () => {
    const oid = async () =>
      (
        await db.query(
          `SELECT oid FROM pg_publication WHERE pubname = 'walter_pub'`
        )
      ).rows[0].oid;
    const before = await oid();
    await new CdcSource(dbUrl, new SchemaCatalog(), ["a", "b"]).setup();
    expect(await published()).toEqual(["public.a", "public.b"]);
    expect(await oid()).toEqual(before);
  });

  it("mode flips recreate the publication", async () => {
    await new CdcSource(dbUrl, new SchemaCatalog()).setup();
    const all = await db.query(
      `SELECT puballtables FROM pg_publication WHERE pubname = 'walter_pub'`
    );
    expect(all.rows[0].puballtables).toBe(true);
    expect(await published()).toEqual(["public.a", "public.b"]);

    const catalog = new SchemaCatalog();
    await new CdcSource(dbUrl, catalog, ["b"]).setup();
    expect(await published()).toEqual(["public.b"]);
    expect(catalog.columnsOf("public.a")).toBeUndefined();
  });

  it("dotted identifiers stay distinct relations end to end", async () => {
    await db.query(`CREATE SCHEMA "x.y"`);
    await db.query(`CREATE SCHEMA x`);
    await db.query(`CREATE TABLE "x.y".c (id int PRIMARY KEY, body text)`);
    await db.query(`CREATE TABLE x."y.c" (id int PRIMARY KEY, body text)`);
    await db.query(`INSERT INTO "x.y".c VALUES (1, 'dotted schema')`);
    await db.query(`INSERT INTO x."y.c" VALUES (2, 'dotted table')`);

    const catalog = new SchemaCatalog();
    const cdc = new CdcSource(dbUrl, catalog, ['"x.y".c', 'x."y.c"']);
    await cdc.setup();
    expect(catalog.keyColumnsOf('"x.y".c')).toEqual(["id"]);
    expect(catalog.keyColumnsOf('x."y.c"')).toEqual(["id"]);

    const pool = pinnedPool({ connectionString: dbUrl, max: 2 });
    const batches: TxnBatch[] = [];
    await startCdc(cdc, b => {
      batches.push(b);
    });
    try {
      const src = new PgRowSource(pool, { defaultSchema: "public" });
      const seedA = await src.scopedRows('"x.y".c', undefined, []);
      const seedB = await src.scopedRows('x."y.c"', undefined, []);
      expect(seedA.rows.map(r => r.body)).toEqual(["dotted schema"]);
      expect(seedB.rows.map(r => r.body)).toEqual(["dotted table"]);

      await db.query(`INSERT INTO "x.y".c VALUES (3, 'wal')`);
      const op = () =>
        batches.flatMap(b => b.ops).find(o => o.newRow?.id === 3);
      const deadline = Date.now() + 10_000;
      while (!op()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for WAL");
        await new Promise(r => setTimeout(r, 25));
      }
      expect(op()!.table).toBe('"x.y".c');
    } finally {
      await cdc.stop();
      await pool.end();
    }
  }, 20000);
});
