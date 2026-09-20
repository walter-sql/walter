import { describe, it, expect } from "vitest";
import { SubscriptionManager } from "../src/subscriptions/manager";
import { SchemaCatalog } from "../src/parser/catalog";
import { MemRowSource } from "../src/lazy/rowsource";
import { absorbedThrough } from "../src/lazy/snapshot";
import { StateStore } from "./state-store";
import { commit } from "./support";
import { initParser } from "../src/parser/parse";
import type { ViewSubscriber } from "../src/subscriptions/shape";

const TABLE = "public.users";
const TTL = 40;

function subscriber(id: string, diffs: unknown[] = []): ViewSubscriber {
  return {
    id,
    snapshot() {},
    diff(c) {
      diffs.push(JSON.parse(c));
    },
    failed() {}
  };
}

async function setup() {
  await initParser();
  const state = new StateStore();
  state.setKeyColumns(TABLE, ["id"]);
  state.ingest([
    { table: TABLE, kind: "insert", newRow: { id: 1, name: "a" } }
  ]);
  const catalog = new SchemaCatalog();
  catalog.setKeyColumns(TABLE, ["id"]);
  catalog.setColumnTypes(TABLE, { id: "int4", name: "text" });
  const source = new MemRowSource(
    t => state.rows(t),
    () => absorbedThrough(10)
  );
  const mgr = new SubscriptionManager(source, catalog, "public", TTL);
  return { state, mgr };
}

const REQ = { sql: "SELECT id, name FROM users", params: [] };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("grace TTL before shape teardown", () => {
  it("keeps the shape alive through the window and reuses it warm", async () => {
    const { state, mgr } = await setup();
    const s1 = await mgr.subscribe(subscriber("s1"), REQ);
    mgr.unsubscribe(s1, "s1");
    expect(mgr.stats.shapes).toBe(1);

    state.ingest([
      { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
    ]);
    mgr.handleTxn(
      commit(20, [
        { table: TABLE, kind: "insert", newRow: { id: 2, name: "b" } }
      ])
    );
    await sleep(TTL / 2);

    const s2 = await mgr.subscribe(subscriber("s2"), REQ);
    expect(s2).toBe(s1);
    expect(mgr.stats.shapes).toBe(1);
    expect(s1.materializer.snapshot()).toHaveLength(2);

    await sleep(TTL + 20);
    expect(mgr.stats.shapes).toBe(1);
    mgr.unsubscribe(s2, "s2");
  });

  it("tears down after the window expires with no subscriber", async () => {
    const { mgr } = await setup();
    const s1 = await mgr.subscribe(subscriber("s1"), REQ);
    mgr.unsubscribe(s1, "s1");
    expect(mgr.stats.shapes).toBe(1);
    await sleep(TTL + 20);
    expect(mgr.stats.shapes).toBe(0);
  });

  it("graceTtlMs = 0 preserves immediate teardown", async () => {
    const { state } = await setup();
    const eager = new SubscriptionManager(
      new MemRowSource(
        t => state.rows(t),
        () => absorbedThrough(10)
      ),
      (() => {
        const c = new SchemaCatalog();
        c.setKeyColumns(TABLE, ["id"]);
        c.setColumnTypes(TABLE, { id: "int4", name: "text" });
        return c;
      })(),
      "public",
      0
    );
    const s1 = await eager.subscribe(subscriber("s1"), REQ);
    eager.unsubscribe(s1, "s1");
    expect(eager.stats.shapes).toBe(0);
  });
});
