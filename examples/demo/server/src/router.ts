import { ORPCError } from "@orpc/server";
import { EngineClient } from "@walter-sql/client";
import { z } from "zod";
import { closeSession, openSession } from "./auth";
import { pool } from "./db";
import { HOUSE_NAMES } from "./house";
import { authed, pub } from "./orpc";
import * as shapes from "./shapes";

const walter = new EngineClient(
  process.env.WALTER_URL ?? "ws://localhost:5544"
);

const auth = {
  me: pub.handler(({ context }) => context.user),

  signIn: pub
    .input(z.object({ name: z.string().trim().min(2).max(32) }))
    .handler(async ({ input, context }) => {
      const taken = HOUSE_NAMES.some(
        n => n.toLowerCase() === input.name.toLowerCase()
      );
      if (taken)
        throw new ORPCError("BAD_REQUEST", {
          message: "That name belongs to the house"
        });
      const { rows } = await pool.query<{ id: string; name: string }>(
        `INSERT INTO users (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = excluded.name
         RETURNING id, name`,
        [input.name]
      );
      const user = rows[0]!;
      await openSession(context.res, user.id);
      return user;
    }),

  signOut: pub.handler(async ({ context }) => {
    await closeSession(context.req, context.res);
  })
};

const auctions = {
  board: pub.handler(async function* ({ signal }) {
    yield* walter.stream(shapes.board(), signal);
  }),

  detail: pub
    .input(z.object({ auctionId: z.uuid() }))
    .handler(async function* ({ input, signal }) {
      yield* walter.stream(shapes.detail(input.auctionId), signal);
    }),

  ticker: pub.handler(async function* ({ signal }) {
    yield* walter.stream(shapes.ticker(), signal);
  }),

  leaderboard: pub.handler(async function* ({ signal }) {
    yield* walter.stream(shapes.leaderboard(), signal);
  }),

  myBids: authed.handler(async function* ({ context, signal }) {
    yield* walter.stream(shapes.myBids(context.user.id), signal);
  }),

  create: authed
    .input(
      z.object({
        title: z.string().trim().min(3).max(80),
        description: z.string().trim().max(200).default(""),
        startingPrice: z.number().positive().max(1_000_000),
        minutes: z.number().int().min(1).max(30)
      })
    )
    .handler(async ({ input, context }) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO auctions (seller_id, title, description, starting_price, ends_at)
         VALUES ($1, $2, $3, $4, now() + $5 * interval '1 minute')
         RETURNING id`,
        [
          context.user.id,
          input.title,
          input.description,
          input.startingPrice,
          input.minutes
        ]
      );
      return { id: rows[0]!.id };
    }),

  bid: authed
    .input(
      z.object({
        auctionId: z.uuid(),
        amount: z.number().positive().max(10_000_000)
      })
    )
    .handler(async ({ input, context }) => {
      const amount = Math.round(input.amount * 100) / 100;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{
          seller_id: string;
          starting_price: string;
          ends_at: Date;
          closed: boolean;
        }>(
          `SELECT seller_id, starting_price, ends_at, closed
           FROM auctions WHERE id = $1 FOR UPDATE`,
          [input.auctionId]
        );
        const auction = rows[0];
        if (!auction) throw new ORPCError("NOT_FOUND");
        if (auction.closed || auction.ends_at.getTime() <= Date.now())
          throw new ORPCError("BAD_REQUEST", {
            message: "This lot has ended"
          });
        if (auction.seller_id === context.user.id)
          throw new ORPCError("BAD_REQUEST", {
            message: "You cannot bid on your own lot"
          });
        const { rows: top } = await client.query<{ high: string | null }>(
          `SELECT max(amount) AS high FROM bids WHERE auction_id = $1`,
          [input.auctionId]
        );
        const high = top[0]!.high === null ? null : Number(top[0]!.high);
        const floor = Number(auction.starting_price);
        if (amount < floor)
          throw new ORPCError("BAD_REQUEST", {
            message: `Bidding starts at $${floor.toFixed(2)}`
          });
        if (high !== null && amount <= high)
          throw new ORPCError("BAD_REQUEST", {
            message: `The high bid is $${high.toFixed(2)}`
          });
        await client.query(
          `INSERT INTO bids (auction_id, bidder_id, amount) VALUES ($1, $2, $3)`,
          [input.auctionId, context.user.id, amount]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
};

const meta = {
  shapes: pub.handler(() => shapes.shapeSql)
};

export const router = { auth, auctions, meta };
