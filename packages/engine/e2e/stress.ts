import { WebSocket } from "ws";
import pg from "pg";
import * as view from "@walter-sql/view";
import type { ServerMessage } from "@walter-sql/view";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://walter:walter@localhost:5444/walter";
const WALTER_URL = process.env.WALTER_URL ?? "ws://localhost:5544";
const SHAPES = 150;
const ROWS = 15_000;
const FIRST_ROOM = 100;
const SQL =
  "SELECT c.id AS id, c.body AS body, u.name AS name FROM comments c " +
  "JOIN users u ON u.id = c.user_id WHERE c.room_id = $1";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function firstMismatch(
  db: pg.Client,
  views: Map<string, view.View>
): Promise<string | undefined> {
  for (let room = FIRST_ROOM; room < FIRST_ROOM + SHAPES; room++) {
    const truth = await db.query(`${SQL} ORDER BY id`, [room]);
    const got = [...(views.get(`room${room}`)?.rows ?? [])].sort(
      (a, b) => (a.id as number) - (b.id as number)
    );
    if (JSON.stringify(got) !== JSON.stringify(truth.rows))
      return `room${room}: ${got.length} rows vs ${truth.rows.length}`;
  }
  return undefined;
}

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(
    "INSERT INTO rooms SELECT g, 'room ' || g " +
      "FROM generate_series($1::int, $1::int + $2::int - 1) g " +
      "ON CONFLICT DO NOTHING",
    [FIRST_ROOM, SHAPES]
  );

  const views = new Map<string, view.View>();
  const ws = new WebSocket(WALTER_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", raw => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    if (msg.type === "error") throw new Error(`refused: ${msg.message}`);
    views.set(
      msg.shapeId,
      view.applyView(views.get(msg.shapeId) ?? view.pendingView, msg)
    );
  });
  for (let room = FIRST_ROOM; room < FIRST_ROOM + SHAPES; room++)
    ws.send(
      JSON.stringify({
        type: "subscribe",
        shapeId: `room${room}`,
        sql: SQL,
        params: [room]
      })
    );
  const live = () => [...views.values()].filter(v => v.status === "live");
  while (live().length < SHAPES) await sleep(10);
  console.log(`[stress] ${SHAPES} subscriptions live`);

  const started = performance.now();
  const base = 1_000_000 + Math.floor(Math.random() * 900_000) * 1000;
  await db.query("BEGIN");
  await db.query(
    "INSERT INTO users SELECT g, 'bulk ' || g, NULL " +
      "FROM generate_series($1::int, $1::int + $2::int - 1) g",
    [base, ROWS]
  );
  await db.query(
    "INSERT INTO comments SELECT g, $3::int + (g % $4::int), g, 'c' || g, 0, false " +
      "FROM generate_series($1::int, $1::int + $2::int - 1) g",
    [base, ROWS, FIRST_ROOM, SHAPES]
  );
  await db.query("COMMIT");
  await db.query("UPDATE users SET name = 'renamed' WHERE id = $1", [base]);

  for (const deadline = Date.now() + 60_000; ; await sleep(100)) {
    const diff = await firstMismatch(db, views);
    if (!diff) break;
    if (Date.now() > deadline) throw new Error(`never converged: ${diff}`);
  }
  console.log(
    `[stress] ${2 * ROWS}-op transaction converged across ${SHAPES} shapes ` +
      `in ${(performance.now() - started).toFixed(0)}ms`
  );

  const stuck = await db.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity " +
      "WHERE pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'"
  );
  if (stuck.rows[0].n > 0)
    throw new Error(`${stuck.rows[0].n} sessions idle in transaction`);

  console.log("[stress] PASS");
  ws.close();
  await db.end();
  process.exit(0);
}

main().catch(e => {
  console.error("[stress] FAIL:", e);
  process.exit(1);
});
