import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { CdcSource } from "../src/cdc/replication";
import { SchemaCatalog } from "../src/parser/catalog";
import type { TxnBatch } from "../src/cdc/types";
import { parseLsn } from "../src/lazy/snapshot";
import { ownDatabase, relay, startCdc } from "./pg";

const CONN = ownDatabase("cdc_stream");
const TABLE = "public.trunc_probe";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!CONN)("CdcSource TRUNCATE decoding", () => {
  let client: pg.Client;
  let cdc: CdcSource;
  const batches: TxnBatch[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: CONN });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS trunc_probe`);
    await client.query(
      `CREATE TABLE trunc_probe (id int PRIMARY KEY, body text)`
    );
    cdc = new CdcSource(CONN!, new SchemaCatalog());
    await cdc.setup();
    await startCdc(cdc, batch => {
      batches.push(batch);
    });
  }, 30_000);

  afterAll(async () => {
    await cdc.stop();
    await client.query(`DROP TABLE IF EXISTS trunc_probe`);
    await client.end();
  });

  it("a truncate txn carries the truncated table", async () => {
    await client.query(`INSERT INTO trunc_probe VALUES (1, 'a')`);
    await waitFor(
      () => batches.some(b => b.ops.some(op => op.table === TABLE)),
      "the insert batch"
    );

    await client.query(`TRUNCATE trunc_probe`);
    await waitFor(
      () => batches.some(b => b.truncated?.includes(TABLE)),
      "a batch with the truncated table"
    );
  }, 15_000);

  it("a logical message arrives as an empty batch past its own position", async () => {
    await client.query(`INSERT INTO trunc_probe VALUES (2, 'b')`);
    const fence = parseLsn(
      (
        await client.query(
          "SELECT pg_logical_emit_message(true, 'walter', '')::text AS lsn"
        )
      ).rows[0].lsn
    );
    await waitFor(
      () => batches.some(b => b.ops.length === 0 && b.position >= fence),
      "the fence to arrive"
    );
    const at = batches.findIndex(b => b.position >= fence);
    expect(
      batches.slice(0, at).some(b => b.ops.some(op => op.newRow?.id === 2))
    ).toBe(true);
  }, 15_000);
});

describe.skipIf(!CONN)("CdcSource stream backpressure", () => {
  const BP_TABLE = "public.bp_probe";
  let client: pg.Client;
  let cdc: CdcSource;
  let inFlight = 0;
  let overlaps = 0;
  const seen: number[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: CONN });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS bp_probe`);
    await client.query(`CREATE TABLE bp_probe (id int PRIMARY KEY)`);
    cdc = new CdcSource(CONN!, new SchemaCatalog());
    await cdc.setup();
    await startCdc(cdc, async batch => {
      inFlight++;
      if (inFlight > 1) overlaps++;
      const ids = batch.ops
        .filter(op => op.table === BP_TABLE)
        .map(op => (op.newRow as { id: number }).id);
      if (ids.length > 0) {
        await new Promise(r => setTimeout(r, 40));
        seen.push(...ids);
      }
      inFlight--;
    });
  }, 30_000);

  afterAll(async () => {
    await cdc.stop();
    await client.query(`DROP TABLE IF EXISTS bp_probe`);
    await client.end();
  });

  it("delivers txns one at a time, in commit order, gated on the handler", async () => {
    for (let id = 1; id <= 8; id++) {
      await client.query(`INSERT INTO bp_probe VALUES (${id})`);
    }
    await waitFor(() => seen.length === 8, "all 8 txns applied");
    expect(overlaps).toBe(0);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  }, 15_000);
});

describe.skipIf(!CONN)("CdcSource stream loss", () => {
  let admin: pg.Client;
  let cdc: CdcSource;

  afterAll(async () => {
    await cdc?.stop();
    await admin?.end();
  });

  it("flips degraded on loss and clears it once a replacement slot is live", async () => {
    admin = new pg.Client({ connectionString: CONN });
    await admin.connect();
    cdc = new CdcSource(CONN!, new SchemaCatalog());
    await cdc.setup();

    let slots = 0;
    expect(cdc.degraded).toBe(true);
    cdc.start(
      () => {},
      () => {
        slots++;
      }
    );
    await waitFor(() => slots === 1, "first slot");
    expect(cdc.degraded).toBe(false);

    const pid = (
      cdc as unknown as { service: { _client: { processID: number } } }
    ).service._client.processID;
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);

    await waitFor(() => cdc.degraded, "degraded on loss");
    expect(slots).toBe(1);

    await waitFor(() => slots === 2, "replacement slot");
    expect(cdc.degraded).toBe(false);
  }, 30_000);
});

describe.skipIf(!CONN)("CdcSource stream stall", () => {
  const STALL_TABLE = "public.stall_probe";
  let admin: pg.Client;
  let link: Awaited<ReturnType<typeof relay>>;
  let cdc: CdcSource;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: CONN });
    await admin.connect();
    await admin.query(`CREATE TABLE stall_probe (id int PRIMARY KEY)`);
    link = await relay(CONN!);
  });

  afterAll(async () => {
    await cdc?.stop();
    await link?.close();
    await admin?.query(`DROP TABLE IF EXISTS stall_probe`);
    await admin?.end();
  });

  it("solicits replies, pauses while applying, and treats silence as loss", async () => {
    cdc = new CdcSource(link.url, new SchemaCatalog(), undefined, "public", {
      statusMs: 100,
      stallMs: 500
    });
    await cdc.setup();
    let slots = 0;
    let release!: () => void;
    const applied = new Promise<void>(r => (release = r));
    cdc.start(
      batch =>
        batch.ops.some(op => op.table === STALL_TABLE) ? applied : undefined,
      () => {
        slots++;
      }
    );
    await waitFor(() => slots === 1, "first slot");

    await sleep(1500);
    expect(slots).toBe(1);
    expect(cdc.degraded).toBe(false);

    await admin.query(`INSERT INTO stall_probe VALUES (1)`);
    await sleep(1500);
    expect(cdc.degraded).toBe(false);
    release();

    link.set("frozen");
    await waitFor(() => cdc.degraded, "stall detected");
    link.set("up");
    await waitFor(() => slots === 2, "replacement slot");
    expect(cdc.degraded).toBe(false);
  }, 20_000);
});
