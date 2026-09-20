import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import type { MyBidRow } from "demo-server/shapes";
import { orpc } from "../orpc";
import { Countdown, money, SqlPeek } from "../ui";

function status(row: MyBidRow, myName: string) {
  const leading = row.highBid?.bidder === myName;
  if (row.closed)
    return leading
      ? { label: "won", tone: "text-emerald-400" }
      : { label: "lost", tone: "text-slate-500" };
  return leading
    ? { label: "leading", tone: "text-emerald-400" }
    : { label: "outbid", tone: "text-rose-400" };
}

export function MyBidsPage() {
  const { data: me } = useQuery(orpc.auth.me.queryOptions());
  const { data: rows } = useQuery({
    ...liveQueryOptions(orpc.auctions.myBids.queryOptions()),
    enabled: !!me
  });

  if (!me)
    return (
      <p className="text-sm text-slate-400">
        Sign in above to follow your bids.
      </p>
    );

  if (rows && rows.length === 0)
    return (
      <p className="text-sm text-slate-400">
        No bids yet. Pick a lot on the{" "}
        <Link to="/" className="text-sky-300 hover:underline">
          board
        </Link>
        .
      </p>
    );

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-sm font-semibold tracking-wider text-slate-400 uppercase">
        My bids
      </h1>
      <ul className="mt-4 divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-900">
        {(rows ?? []).map(row => {
          const { label, tone } = status(row, me.name);
          return (
            <li key={row.id}>
              <Link
                to="/lot/$auctionId"
                params={{ auctionId: row.id }}
                className="flex items-center gap-4 px-4 py-3 text-sm hover:bg-slate-800/40"
              >
                <span className="flex-1 font-medium">{row.title}</span>
                <span className={`text-xs font-semibold uppercase ${tone}`}>
                  {label}
                </span>
                <span className="w-24 text-right text-xs text-slate-500">
                  me {row.myBid ? money(row.myBid.amount) : "-"}
                </span>
                <span className="w-24 text-right tabular-nums text-amber-300">
                  {row.highBid ? money(row.highBid.amount) : "-"}
                </span>
                <Countdown endsAt={row.endsAt} closed={row.closed} />
              </Link>
            </li>
          );
        })}
      </ul>
      <SqlPeek name="myBids" />
    </div>
  );
}
