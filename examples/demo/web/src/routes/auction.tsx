import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import { useState } from "react";
import type { DetailRow } from "demo-server/shapes";
import { orpc } from "../orpc";
import { Countdown, Flash, money, SqlPeek } from "../ui";

const route = getRouteApi("/lot/$auctionId");

function BidForm({ lot }: { lot: DetailRow }) {
  const { data: me } = useQuery(orpc.auth.me.queryOptions());
  const [amount, setAmount] = useState("");
  const bid = useMutation(
    orpc.auctions.bid.mutationOptions({ onSuccess: () => setAmount("") })
  );

  if (!me)
    return <p className="text-sm text-slate-400">Sign in above to bid.</p>;

  const current = lot.highBid
    ? Number(lot.highBid.amount)
    : Number(lot.startingPrice);
  const suggested = lot.highBid ? Math.round(current * 105) / 100 : current;

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        bid.mutate({ auctionId: lot.id, amount: Number(amount || suggested) });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <div className="relative">
        <span className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-500">
          $
        </span>
        <input
          value={amount}
          onChange={event => setAmount(event.target.value)}
          placeholder={suggested.toFixed(2)}
          inputMode="decimal"
          className="w-32 rounded border border-slate-700 bg-slate-900 py-2 pr-3 pl-7 text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      </div>
      <button
        disabled={bid.isPending}
        className="rounded bg-amber-500 px-4 py-2 font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
      >
        Place bid
      </button>
      {bid.error && (
        <span className="text-sm text-rose-400">{bid.error.message}</span>
      )}
    </form>
  );
}

export function AuctionPage() {
  const { auctionId } = route.useParams();
  const { data, isPending } = useQuery(
    liveQueryOptions(
      orpc.auctions.detail.queryOptions({ input: { auctionId } })
    )
  );
  const lot = data?.[0];

  if (isPending) return null;
  if (!lot)
    return <p className="text-sm text-slate-500">This lot does not exist.</p>;

  const bids = lot.bids ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{lot.title}</h1>
            <p className="mt-1 text-sm text-slate-400">{lot.description}</p>
            <p className="mt-1 text-xs text-slate-500">
              listed by {lot.seller.name}
            </p>
          </div>
          <Countdown endsAt={lot.endsAt} closed={lot.closed} />
        </div>

        <div className="mt-6 flex items-baseline gap-3">
          {lot.highBid ? (
            <>
              <Flash
                value={money(lot.highBid.amount)}
                className="text-3xl font-semibold text-amber-300"
              />
              <span className="text-sm text-slate-400">
                {lot.closed ? "sold to" : "held by"} {lot.highBid.bidder}
              </span>
            </>
          ) : (
            <span className="text-lg text-slate-400">
              {lot.closed
                ? "ended with no bids"
                : `starts at ${money(lot.startingPrice)}`}
            </span>
          )}
        </div>

        <div className="mt-6">
          {lot.closed ? (
            <p className="text-sm text-slate-500">Bidding has closed.</p>
          ) : (
            <BidForm lot={lot} />
          )}
        </div>
      </div>

      {bids.length > 0 && (
        <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h2 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
            Bid history
          </h2>
          <ul className="mt-3 space-y-1">
            {bids.map(entry => (
              <li
                key={entry.id}
                className="animate-slide-in flex justify-between text-sm"
              >
                <span className="text-slate-300">{entry.bidder}</span>
                <span className="tabular-nums text-slate-100">
                  {money(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SqlPeek name="detail" />
    </div>
  );
}
