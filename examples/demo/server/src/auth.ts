import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./db";

export type User = { id: string; name: string };

const COOKIE = "demo_session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionId(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (UUID.test(value)) return value;
  }
  return null;
}

export async function sessionUser(req: IncomingMessage): Promise<User | null> {
  const id = sessionId(req);
  if (!id) return null;
  const { rows } = await pool.query<User>(
    `SELECT u.id, u.name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function openSession(
  res: ServerResponse,
  userId: string
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id) VALUES ($1) RETURNING id`,
    [userId]
  );
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${rows[0]!.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
  );
}

export async function closeSession(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const id = sessionId(req);
  if (id) await pool.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  res.setHeader(
    "set-cookie",
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}
