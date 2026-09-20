import { WebSocket } from "ws";
import pg from "pg";
import * as view from "@walter-sql/view";
import type { ServerMessage } from "@walter-sql/view";
import { canonicalize, stableStringify } from "../src/ivm/zset";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://walter:walter@localhost:5444/walter";
const WALTER_URL = process.env.WALTER_URL ?? "ws://localhost:5544";
const ITERATIONS = process.env.ITERATIONS
  ? Number(process.env.ITERATIONS)
  : 200;

interface Shape {
  id: string;
  sql: string;
  params: unknown[];
  view: view.View;
}

const SHAPES: Shape[] = [
  {
    id: "flat",
    sql: "SELECT id, body, score FROM comments WHERE room_id = $1 AND deleted = false",
    params: [1],
    view: view.pendingView
  },
  {
    id: "nested",
    sql:
      "SELECT c.id AS id, c.body AS body, " +
      "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS author, " +
      "coalesce(json_agg(json_build_object('id', r.id, 'body', r.body) ORDER BY r.body, r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies " +
      "FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN replies r ON r.comment_id = c.id " +
      "WHERE c.deleted = false GROUP BY c.id, u.id",
    params: [],
    view: view.pendingView
  },
  {
    id: "agg",
    sql: "SELECT user_id AS user_id, count(*) AS n, sum(score) AS total, max(score) AS hi FROM comments WHERE deleted = false GROUP BY user_id",
    params: [],
    view: view.pendingView
  },
  {
    id: "topk",
    sql: "SELECT id, score FROM comments WHERE deleted = false ORDER BY score DESC, id ASC LIMIT 5",
    params: [],
    view: view.pendingView
  }
];

const norm = (v: unknown): unknown =>
  typeof v === "string" && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v))
    ? Number(v)
    : v;

function multiset(rows: Record<string, unknown>[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const row of rows) {
    const normed = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, norm(v)])
    );
    const k = stableStringify(canonicalize(normed));
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function diffMultisets(
  a: Map<string, number>,
  b: Map<string, number>
): string | undefined {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) {
      return `row count differs:\n  engine=${a.get(k) ?? 0} pg=${b.get(k) ?? 0}\n  row=${k}`;
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function connectEngine(): Promise<WebSocket> {
  const ws = new WebSocket(WALTER_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", raw => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    if (msg.type === "error") throw new Error(`refused: ${msg.message}`);
    const shape = SHAPES.find(s => s.id === msg.shapeId);
    if (shape) shape.view = view.applyView(shape.view, msg);
  });
  for (const shape of SHAPES) {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        shapeId: shape.id,
        sql: shape.sql,
        params: shape.params
      })
    );
  }
  return ws;
}

async function compareAll(db: pg.Client): Promise<string | undefined> {
  for (const shape of SHAPES) {
    const truth = await db.query(shape.sql, shape.params as any[]);
    const engineRows = shape.view.rows;
    const diff = diffMultisets(multiset(engineRows), multiset(truth.rows));
    if (diff) return `shape "${shape.id}" diverged:\n${diff}`;
  }
  return undefined;
}

async function waitConsistent(db: pg.Client, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const diff = await compareAll(db);
    if (!diff) return;
    if (Date.now() > deadline) throw new Error(diff);
    await sleep(15);
  }
}

let seq = 1000;
let userSeq = 3;
function rand(n: number): number {
  return Math.floor(Math.random() * n);
}

const userIds = [1, 2, 3];

async function maybeNewUser(db: pg.Client): Promise<void> {
  if (rand(5) !== 0) return;
  const id = ++userSeq;
  await db.query(
    "INSERT INTO users (id, name, avatar) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [id, `u${id}`, `${id}.png`]
  );
  userIds.push(id);
}

async function randomWrite(db: pg.Client): Promise<void> {
  await maybeNewUser(db);
  const choice = rand(6);
  if (choice <= 2) {
    const id = ++seq;
    if (rand(2) === 0) {
      await db.query(
        "INSERT INTO comments (id, room_id, user_id, body, score, deleted) VALUES ($1,$2,$3,$4,$5,false)",
        [id, 1 + rand(2), pick(userIds), pick(["x", "y", "z"]), rand(10)]
      );
    } else {
      const c = await db.query(
        "SELECT id FROM comments ORDER BY random() LIMIT 1"
      );
      if (c.rows[0]) {
        await db.query(
          "INSERT INTO replies (id, comment_id, user_id, body) VALUES ($1,$2,$3,$4)",
          [id, c.rows[0].id, pick(userIds), pick(["a", "b", "c"])]
        );
      }
    }
  } else if (choice <= 4) {
    const c = await db.query(
      "SELECT id FROM comments ORDER BY random() LIMIT 1"
    );
    if (c.rows[0]) {
      if (rand(3) === 0) {
        await db.query(
          "UPDATE comments SET score = $2, body = $3 WHERE id = $1",
          [c.rows[0].id, rand(10), pick(["x", "y", "z"])]
        );
      } else if (rand(2) === 0) {
        await db.query(
          "UPDATE replies SET body = $1 WHERE id = (SELECT id FROM replies ORDER BY random() LIMIT 1)",
          [pick(["a", "b", "c"])]
        );
      } else {
        await db.query("UPDATE comments SET user_id = $2 WHERE id = $1", [
          c.rows[0].id,
          pick(userIds)
        ]);
      }
    }
  } else {
    const c = await db.query(
      "SELECT id FROM comments WHERE deleted = false ORDER BY random() LIMIT 1"
    );
    if (c.rows[0]) {
      if (rand(2) === 0) {
        await db.query("UPDATE comments SET deleted = true WHERE id = $1", [
          c.rows[0].id
        ]);
      } else {
        await db.query("DELETE FROM replies WHERE comment_id = $1", [
          c.rows[0].id
        ]);
        await db.query("DELETE FROM comments WHERE id = $1", [c.rows[0].id]);
      }
    }
  }
}

function pick<T>(arr: T[]): T {
  return arr[rand(arr.length)]!;
}

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const ids = await db.query(
    "SELECT greatest((SELECT max(id) FROM comments), (SELECT max(id) FROM replies), 1000) AS seq, greatest((SELECT max(id) FROM users), 3) AS u"
  );
  seq = Number(ids.rows[0].seq);
  userSeq = Number(ids.rows[0].u);
  const ws = await connectEngine();

  await waitConsistent(db);
  console.log("[differential] initial snapshot matches Postgres");

  for (let i = 0; i < ITERATIONS; i++) {
    await db.query("BEGIN");
    const ops = 1 + rand(3);
    for (let j = 0; j < ops; j++) await randomWrite(db);
    await db.query("COMMIT");
    await waitConsistent(db);
    if ((i + 1) % 25 === 0)
      console.log(`[differential] ${i + 1}/${ITERATIONS} transactions OK`);
  }

  console.log(
    `[differential] PASS: ${ITERATIONS} transactions, ${SHAPES.length} shapes, all consistent`
  );
  ws.close();
  await db.end();
  process.exit(0);
}

main().catch(e => {
  console.error("[differential] FAIL:", e);
  process.exit(1);
});
