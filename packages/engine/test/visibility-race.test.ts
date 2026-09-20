import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { applyView, pendingView, type View } from "@walter-sql/view";
import { PgRowSource, pinnedPool } from "../src/lazy/pg-source";
import { parseLsn } from "../src/lazy/snapshot";
import { Stream } from "../src/lazy/stream";
import { SubscriptionManager } from "../src/subscriptions/manager";
import { SchemaCatalog } from "../src/parser/catalog";
import { initParser } from "../src/parser/parse";
import type { ViewSubscriber } from "../src/subscriptions/shape";
import { commit, withReads, type RowOp } from "./support";
import { ownDatabase } from "./pg";

const CONN = ownDatabase("visibility_race");
if (!CONN && process.env.CI) {
  throw new Error("CI must set WALTER_TEST_PG (visibility race cannot skip)");
}

const USERS = "public.race_users";
const COMMENTS = "public.race_comments";
const JOIN =
  "SELECT c.id AS id, c.body AS body, u.name AS name FROM race_comments c " +
  "JOIN race_users u ON u.id = c.user_id WHERE c.room_id = $1";

function catalog(): SchemaCatalog {
  const c = new SchemaCatalog();
  c.setKeyColumns(USERS, ["id"]);
  c.setColumnTypes(USERS, { id: "int4", name: "text" });
  c.setKeyColumns(COMMENTS, ["id"]);
  c.setColumnTypes(COMMENTS, {
    id: "int4",
    user_id: "int4",
    room_id: "int4",
    body: "text"
  });
  return c;
}

function viewer() {
  let view: View = pendingView;
  let diffs = 0;
  const sub: ViewSubscriber = {
    id: "s1",
    snapshot(rows) {
      view = applyView(view, {
        type: "snapshot",
        shapeId: "s1",
        rows: JSON.parse(rows)
      });
    },
    diff(changes) {
      diffs++;
      view = applyView(view, {
        type: "diff",
        shapeId: "s1",
        changes: JSON.parse(changes)
      });
    },
    failed() {
      throw new Error("shape failed");
    }
  };
  return { sub, rows: () => view.rows, diffs: () => diffs };
}

describe.skipIf(!CONN)("reads against the change stream", () => {
  let pool: pg.Pool;
  let writer: pg.Client;

  const flushed = async (): Promise<bigint> =>
    parseLsn(
      (await pool.query("SELECT pg_current_wal_flush_lsn()::text AS pos"))
        .rows[0].pos
    );

  const xidOf = async (client: pg.Client): Promise<number> =>
    Number(
      (await client.query("SELECT pg_current_xact_id()::xid::text AS x"))
        .rows[0].x
    );

  async function streamUntil(stream: Stream, done: () => boolean) {
    for (const deadline = Date.now() + 4_000; !done();) {
      if (Date.now() > deadline) throw new Error("stream never caught up");
      stream.advance(await flushed());
      await sleep(5);
    }
  }

  async function subscribe(
    mgr: SubscriptionManager,
    stream: Stream,
    sub: ViewSubscriber,
    params: unknown[]
  ) {
    let live = false;
    await Promise.all([
      mgr.subscribe(sub, { sql: JOIN, params }).then(() => (live = true)),
      streamUntil(stream, () => live)
    ]);
  }

  beforeAll(async () => {
    await initParser();
    pool = pinnedPool({ connectionString: CONN });
    writer = new pg.Client({ connectionString: CONN });
    await writer.connect();
    await writer.query(
      "CREATE TABLE race_users (id int PRIMARY KEY, name text)"
    );
    await writer.query(
      "CREATE TABLE race_comments (id int PRIMARY KEY, user_id int, room_id int, body text)"
    );
  });

  afterAll(async () => {
    await writer.end();
    await pool.end();
  });

  it("applies a transaction that committed after the read's snapshot", async () => {
    await writer.query("INSERT INTO race_users VALUES (1, 'v0')");
    await writer.query("BEGIN");
    await writer.query("UPDATE race_users SET name = 'v1' WHERE id = 1");
    const xid = await xidOf(writer);

    const inner = new PgRowSource(pool, { defaultSchema: "public" });
    let commitOnce: (() => Promise<unknown>) | undefined = () =>
      writer.query("COMMIT");
    const source = withReads(inner, {
      async scopedRows(table, predicate, params) {
        const read = await inner.scopedRows(table, predicate, params);
        await commitOnce?.();
        commitOnce = undefined;
        return read;
      }
    });
    const mgr = new SubscriptionManager(source, catalog(), "public", 30_000);
    const v = viewer();
    await mgr.subscribe(v.sub, {
      sql: "SELECT id, name FROM race_users WHERE id = $1",
      params: [1]
    });
    expect(v.rows()).toEqual([{ id: 1, name: "v0" }]);

    await mgr.handleTxn(
      commit(xid, [
        {
          table: USERS,
          kind: "update",
          newRow: { id: 1, name: "v1" },
          oldRow: { id: 1, name: "v0" }
        }
      ])
    );
    await mgr.settled();
    expect(v.rows()).toEqual([{ id: 1, name: "v1" }]);
  });

  it("waits for Postgres to show a transaction the stream already delivered", async () => {
    const stream = new Stream();
    const source = new PgRowSource(pool, { defaultSchema: "public", stream });
    const mgr = new SubscriptionManager(
      source,
      catalog(),
      "public",
      30_000,
      stream
    );
    const v = viewer();
    await subscribe(mgr, stream, v.sub, [10]);
    expect(v.rows()).toEqual([]);

    await writer.query("BEGIN");
    await writer.query("INSERT INTO race_users VALUES (7, 'Ann')");
    await writer.query("INSERT INTO race_comments VALUES (70, 7, 10, 'hello')");
    const xid = await xidOf(writer);
    const ops: RowOp[] = [
      { table: USERS, kind: "insert", newRow: { id: 7, name: "Ann" } },
      {
        table: COMMENTS,
        kind: "insert",
        newRow: { id: 70, user_id: 7, room_id: 10, body: "hello" }
      }
    ];
    void mgr.handleTxn(commit(xid, ops, undefined, await flushed()));
    await sleep(60);
    expect(v.rows()).toEqual([]);

    await writer.query("COMMIT");
    await streamUntil(stream, () => v.diffs() > 0);
    expect(v.rows()).toEqual([{ id: 70, body: "hello", name: "Ann" }]);
  });

  it("sends nothing until the stream has caught up with a read", async () => {
    const stream = new Stream();
    const source = new PgRowSource(pool, { defaultSchema: "public", stream });
    const mgr = new SubscriptionManager(
      source,
      catalog(),
      "public",
      30_000,
      stream
    );
    const v = viewer();
    await subscribe(mgr, stream, v.sub, [20]);

    await writer.query("BEGIN");
    await writer.query("INSERT INTO race_users VALUES (8, 'Bob')");
    await writer.query("INSERT INTO race_comments VALUES (80, 8, 20, 'first')");
    const first = await xidOf(writer);
    await writer.query("COMMIT");
    const firstAt = await flushed();

    await writer.query("BEGIN");
    await writer.query("UPDATE race_users SET name = 'Robert' WHERE id = 8");
    await writer.query(
      "UPDATE race_comments SET body = 'second' WHERE id = 80"
    );
    const second = await xidOf(writer);
    await writer.query("COMMIT");
    const secondAt = await flushed();

    const comment = (body: string) => ({
      id: 80,
      user_id: 8,
      room_id: 20,
      body
    });
    void mgr.handleTxn(
      commit(
        first,
        [
          { table: USERS, kind: "insert", newRow: { id: 8, name: "Bob" } },
          { table: COMMENTS, kind: "insert", newRow: comment("first") }
        ],
        undefined,
        firstAt
      )
    );
    await mgr.settled();
    await sleep(50);
    expect(v.diffs()).toBe(0);

    void mgr.handleTxn(
      commit(
        second,
        [
          {
            table: USERS,
            kind: "update",
            oldRow: { id: 8, name: "Bob" },
            newRow: { id: 8, name: "Robert" }
          },
          {
            table: COMMENTS,
            kind: "update",
            oldRow: comment("first"),
            newRow: comment("second")
          }
        ],
        undefined,
        secondAt
      )
    );
    await streamUntil(stream, () => v.diffs() > 0);
    expect(v.diffs()).toBe(1);
    expect(v.rows()).toEqual([{ id: 80, body: "second", name: "Robert" }]);
  });
});
