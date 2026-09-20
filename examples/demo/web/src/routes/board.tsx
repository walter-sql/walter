import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import { useState } from "react";
import type { BoardRow, TickerRow } from "demo-server/shapes";
import { orpc } from "../orpc";
import { Countdown, Flash, money, SqlPeek } from "../ui";

function LotCard({ lot }: { lot: BoardRow }) {
  return (
    <Link
      to="/lot/$auctionId"
      params={{ auctionId: lot.id }}
      className="group rounded-lg border border-slate-800 bg-slate-900 p-4 transition hover:border-sky-700"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium group-hover:text-white">{lot.title}</h3>
        <Countdown endsAt={lot.endsAt} />
      </div>
      <p className="mt-1 text-xs text-slate-500">listed by {lot.seller}</p>
      <div className="mt-3 flex items-baseline justify-between">
        {lot.highBid === null ? (
          <span className="text-sm text-slate-400">
            starts at {money(lot.startingPrice)}
          </span>
        ) : (
          <Flash
            value={money(lot.highBid)}
            className="text-lg font-semibold text-amber-300"
          />
        )}
        <span className="text-xs text-slate-500">
          {lot.bidCount} bids · {lot.bidderCount} bidders
        </span>
      </div>
    </Link>
  );
}

function TickerLine({ bid }: { bid: TickerRow }) {
  return (
    <li className="animate-slide-in">
      <Link
        to="/lot/$auctionId"
        params={{ auctionId: bid.auctionId }}
        className="block truncate text-sm hover:text-white"
      >
        <span className="font-medium text-amber-300">{money(bid.amount)}</span>
        <span className="text-slate-400">
          {" "}
          {bid.bidder} · {bid.title}
        </span>
      </Link>
    </li>
  );
}

function Ticker() {
  const { data: bids } = useQuery(
    liveQueryOptions(orpc.auctions.ticker.queryOptions())
  );
  return (
    <aside className="self-start rounded-lg border border-slate-800 bg-slate-900 p-4 lg:sticky lg:top-20">
      <h2 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
        Live bids
      </h2>
      <ul className="mt-3 space-y-2">
        {(bids ?? []).map(bid => (
          <TickerLine key={bid.id} bid={bid} />
        ))}
      </ul>
      <SqlPeek name="ticker" />
    </aside>
  );
}

function ListForm() {
  const { data: me } = useQuery(orpc.auth.me.queryOptions());
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [minutes, setMinutes] = useState("5");
  const create = useMutation(
    orpc.auctions.create.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setTitle("");
        setDescription("");
        setPrice("");
      }
    })
  );

  if (!me) return null;
  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500"
      >
        List an item
      </button>
    );

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        create.mutate({
          title,
          description,
          startingPrice: Number(price),
          minutes: Number(minutes)
        });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        value={title}
        onChange={event => setTitle(event.target.value)}
        placeholder="title"
        className="w-44 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      <input
        value={description}
        onChange={event => setDescription(event.target.value)}
        placeholder="description"
        className="w-56 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      <input
        value={price}
        onChange={event => setPrice(event.target.value)}
        placeholder="price"
        inputMode="decimal"
        className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      <select
        value={minutes}
        onChange={event => setMinutes(event.target.value)}
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm focus:border-sky-600 focus:outline-none"
      >
        {[2, 5, 10, 20, 30].map(m => (
          <option key={m} value={m}>
            {m} min
          </option>
        ))}
      </select>
      <button
        disabled={create.isPending}
        className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
      >
        List
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-sm text-slate-500 hover:text-slate-300"
      >
        Cancel
      </button>
      {create.error && (
        <span className="text-xs text-rose-400">{create.error.message}</span>
      )}
    </form>
  );
}

export function BoardPage() {
  const { data: lots } = useQuery(
    liveQueryOptions(orpc.auctions.board.queryOptions())
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-sm font-semibold tracking-wider text-slate-400 uppercase">
            Open lots
          </h1>
          <ListForm />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(lots ?? []).map(lot => (
            <LotCard key={lot.id} lot={lot} />
          ))}
        </div>
        <SqlPeek name="board" />
      </div>
      <Ticker />
    </div>
  );
}
