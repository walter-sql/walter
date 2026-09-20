import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { orpc } from "./orpc";

function SessionBox() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(orpc.auth.me.queryOptions());
  const signIn = useMutation(
    orpc.auth.signIn.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries()
    })
  );
  const signOut = useMutation(
    orpc.auth.signOut.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries()
    })
  );
  const [name, setName] = useState("");

  if (me)
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-slate-400">
          bidding as{" "}
          <span className="font-medium text-slate-100">{me.name}</span>
        </span>
        <button
          onClick={() => signOut.mutate({})}
          className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500"
        >
          Sign out
        </button>
      </div>
    );

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (name.trim()) signIn.mutate({ name });
      }}
      className="flex items-center gap-2"
    >
      <input
        value={name}
        onChange={event => setName(event.target.value)}
        placeholder="your name"
        className="w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      <button
        disabled={signIn.isPending}
        className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
      >
        Sign in
      </button>
      {signIn.error && (
        <span className="text-xs text-rose-400">{signIn.error.message}</span>
      )}
    </form>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-[0.3em] text-amber-300">
              AUCTIONS
            </span>
            <span className="hidden text-xs text-slate-500 sm:inline">
              live auctions on Walter
            </span>
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link
              to="/"
              className="text-slate-400 hover:text-slate-200"
              activeProps={{ className: "text-slate-100" }}
              activeOptions={{ exact: true }}
            >
              Lots
            </Link>
            <Link
              to="/leaderboard"
              className="text-slate-400 hover:text-slate-200"
              activeProps={{ className: "text-slate-100" }}
            >
              Leaderboard
            </Link>
            <Link
              to="/bids"
              className="text-slate-400 hover:text-slate-200"
              activeProps={{ className: "text-slate-100" }}
            >
              My bids
            </Link>
          </nav>
          <div className="ml-auto">
            <SessionBox />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
