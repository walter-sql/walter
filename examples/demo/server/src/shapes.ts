import type { EngineShape } from "@walter-sql/client";

export type BoardRow = {
  id: string;
  title: string;
  startingPrice: string;
  endsAt: string;
  seller: string;
  highBid: string | null;
  bidCount: string;
  bidderCount: string;
};

export type BidEntry = {
  id: string;
  amount: string;
  bidder: string;
  at: string;
};

export type HighBid = {
  amount: string;
  bidder: string;
} | null;

export type DetailRow = {
  id: string;
  title: string;
  description: string;
  startingPrice: string;
  endsAt: string;
  closed: boolean;
  seller: { id: string; name: string };
  highBid: HighBid;
  bids: BidEntry[] | null;
};

export type TickerRow = {
  id: string;
  auctionId: string;
  title: string;
  bidder: string;
  amount: string;
  at: string;
};

export type LeaderRow = {
  id: string;
  name: string;
  volume: string;
  bidCount: string;
};

export type MyBidRow = {
  id: string;
  title: string;
  endsAt: string;
  closed: boolean;
  highBid: HighBid;
  myBid: { amount: string } | null;
};

const highBidSql = `(SELECT json_build_object('amount', hb.amount, 'bidder', hu.name)
         FROM bids hb JOIN users hu ON hu.id = hb.bidder_id
         WHERE hb.auction_id = a.id
         ORDER BY hb.amount DESC, hb.created_at, hb.id
         LIMIT 1) AS "highBid"`;

const boardSql = `SELECT a.id, a.title, a.starting_price AS "startingPrice", a.ends_at AS "endsAt",
       s.name AS seller,
       max(b.amount) AS "highBid",
       count(b.id) AS "bidCount",
       count(DISTINCT b.bidder_id) AS "bidderCount"
FROM auctions a
JOIN users s ON s.id = a.seller_id
LEFT JOIN bids b ON b.auction_id = a.id
WHERE NOT a.closed
GROUP BY a.id, a.title, a.starting_price, a.ends_at, s.name
ORDER BY a.ends_at, a.id
LIMIT 50`;

const detailSql = `SELECT a.id, a.title, a.description, a.starting_price AS "startingPrice",
       a.ends_at AS "endsAt", a.closed,
       json_build_object('id', s.id, 'name', s.name) AS seller,
       ${highBidSql},
       (SELECT json_agg(json_build_object(
                 'id', b.id, 'amount', b.amount,
                 'bidder', u.name, 'at', b.created_at)
               ORDER BY b.created_at DESC, b.id)
        FROM bids b JOIN users u ON u.id = b.bidder_id
        WHERE b.auction_id = a.id) AS bids
FROM auctions a
JOIN users s ON s.id = a.seller_id
WHERE a.id = $1`;

const tickerSql = `SELECT b.id, a.id AS "auctionId", a.title, u.name AS bidder,
       b.amount, b.created_at AS "at"
FROM bids b
JOIN auctions a ON a.id = b.auction_id
JOIN users u ON u.id = b.bidder_id
ORDER BY b.created_at DESC, b.id
LIMIT 20`;

const leaderboardSql = `SELECT u.id, u.name, sum(b.amount) AS volume, count(b.id) AS "bidCount"
FROM bids b
JOIN users u ON u.id = b.bidder_id
GROUP BY u.id, u.name
HAVING count(b.id) >= 3
ORDER BY sum(b.amount) DESC
LIMIT 10`;

const myBidsSql = `SELECT a.id, a.title, a.ends_at AS "endsAt", a.closed,
       ${highBidSql},
       (SELECT json_build_object('amount', mb.amount)
        FROM bids mb
        WHERE mb.auction_id = a.id AND mb.bidder_id = $1
        ORDER BY mb.amount DESC, mb.created_at, mb.id
        LIMIT 1) AS "myBid"
FROM auctions a
WHERE EXISTS (SELECT 1 FROM bids e
              WHERE e.auction_id = a.id AND e.bidder_id = $1)
ORDER BY a.closed, a.ends_at DESC
LIMIT 50`;

export const board = (): EngineShape<BoardRow> => ({ sql: boardSql });

export const detail = (auctionId: string): EngineShape<DetailRow> => ({
  sql: detailSql,
  params: [auctionId]
});

export const ticker = (): EngineShape<TickerRow> => ({ sql: tickerSql });

export const leaderboard = (): EngineShape<LeaderRow> => ({
  sql: leaderboardSql
});

export const myBids = (userId: string): EngineShape<MyBidRow> => ({
  sql: myBidsSql,
  params: [userId]
});

export const shapeSql = {
  board: boardSql,
  detail: detailSql,
  ticker: tickerSql,
  leaderboard: leaderboardSql,
  myBids: myBidsSql
};
