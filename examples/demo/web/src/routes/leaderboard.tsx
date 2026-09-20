import { useQuery } from "@tanstack/react-query";
import { liveQueryOptions } from "@walter-sql/tanstack-query";
import { orpc } from "../orpc";
import { Flash, money, SqlPeek } from "../ui";

export function LeaderboardPage() {
  const { data: leaders } = useQuery(
    liveQueryOptions(orpc.auctions.leaderboard.queryOptions())
  );
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-sm font-semibold tracking-wider text-slate-400 uppercase">
        Biggest spenders
      </h1>
      <p className="mt-1 text-xs text-slate-500">
        Three bids or more to make the board.
      </p>
      <ol className="mt-4 divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-900">
        {(leaders ?? []).map((leader, index) => (
          <li
            key={leader.id}
            className="flex items-center gap-4 px-4 py-3 text-sm"
          >
            <span className="w-6 text-right text-slate-500 tabular-nums">
              {index + 1}
            </span>
            <span className="flex-1 font-medium">{leader.name}</span>
            <span className="text-xs text-slate-500">
              {leader.bidCount} bids
            </span>
            <Flash
              value={money(leader.volume)}
              className="w-28 text-right tabular-nums text-amber-300"
            />
          </li>
        ))}
      </ol>
      <SqlPeek name="leaderboard" />
    </div>
  );
}
