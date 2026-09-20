import { pool } from "./db";
import { CATALOG, HOUSE_NAMES } from "./house";

type HouseUser = { id: string; name: string };

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)]!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function houseUsers(): Promise<HouseUser[]> {
  const { rows } = await pool.query<HouseUser>(
    `SELECT id, name FROM users WHERE name = ANY($1)`,
    [HOUSE_NAMES]
  );
  return rows;
}

async function closeEnded(): Promise<void> {
  const { rows } = await pool.query<{ title: string }>(
    `UPDATE auctions SET closed = true
     WHERE NOT closed AND ends_at <= now()
     RETURNING title`
  );
  for (const { title } of rows) console.log(`closed  ${title}`);
}

async function prune(): Promise<void> {
  const { rows } = await pool.query<{ id: string; title: string }>(
    `SELECT id, title FROM auctions
     WHERE closed AND ends_at < now() - interval '1 hour'`
  );
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);
  await pool.query(`DELETE FROM bids WHERE auction_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM auctions WHERE id = ANY($1)`, [ids]);
  for (const { title } of rows) console.log(`pruned  ${title}`);
}

async function restock(sellers: HouseUser[]): Promise<void> {
  const { rows } = await pool.query<{ open: number }>(
    `SELECT count(*)::int AS open FROM auctions WHERE NOT closed`
  );
  if (rows[0]!.open >= 6) return;
  const lot = pick(CATALOG);
  const minutes = 3 + rand(8);
  await pool.query(
    `INSERT INTO auctions (seller_id, title, description, starting_price, ends_at)
     VALUES ($1, $2, $3, $4, now() + $5 * interval '1 minute')`,
    [pick(sellers).id, lot.title, lot.description, lot.floor, minutes]
  );
  console.log(`listed  ${lot.title} (${minutes}m)`);
}

async function bid(bidders: HouseUser[]): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    title: string;
    seller_id: string;
    floor: number;
    high: number | null;
  }>(
    `SELECT a.id, a.title, a.seller_id,
            a.starting_price::float8 AS floor,
            max(b.amount)::float8 AS high
     FROM auctions a
     LEFT JOIN bids b ON b.auction_id = a.id
     WHERE NOT a.closed AND a.ends_at > now()
     GROUP BY a.id, a.title, a.seller_id, a.starting_price
     ORDER BY random()
     LIMIT 1`
  );
  const lot = rows[0];
  if (!lot) return;
  const eligible = bidders.filter(u => u.id !== lot.seller_id);
  const bidder = pick(eligible);
  const base = lot.high ?? lot.floor;
  const amount = Math.round(base * (1.02 + Math.random() * 0.08) * 100) / 100;
  await pool.query(
    `INSERT INTO bids (auction_id, bidder_id, amount)
     SELECT $1, $2, $3
     WHERE $3::numeric > coalesce((SELECT max(amount) FROM bids WHERE auction_id = $1), 0)`,
    [lot.id, bidder.id, amount]
  );
  console.log(`bid     $${amount.toFixed(2)} on ${lot.title} (${bidder.name})`);
}

const users = await houseUsers();
console.log(`the house is in: ${users.map(u => u.name).join(", ")}`);

for (;;) {
  try {
    await closeEnded();
    await prune();
    await restock(users);
    if (Math.random() < 0.75) await bid(users);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await sleep(1200 + rand(2300));
}
