import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { orpc } from "./orpc";

export const money = (value: string | number): string =>
  `$${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const parseTs = (text: string): Date =>
  new Date(
    text
      .replace(" ", "T")
      .replace(/(\.\d{3})\d+/, "$1")
      .replace(/\+00$/, "Z")
  );

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Countdown({
  endsAt,
  closed = false
}: {
  endsAt: string;
  closed?: boolean;
}) {
  const now = useNow();
  if (closed) return <span className="text-xs text-slate-500">ended</span>;
  const left = parseTs(endsAt).getTime() - now;
  if (left <= 0) return <span className="text-xs text-rose-400">closing</span>;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return (
    <span
      className={`text-xs tabular-nums ${left < 30000 ? "text-rose-400" : "text-sky-300"}`}
    >
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

export function Flash({
  value,
  className = ""
}: {
  value: string;
  className?: string;
}) {
  return (
    <span key={value} className={`animate-pop -mx-1 rounded px-1 ${className}`}>
      {value}
    </span>
  );
}

type ShapeName = "board" | "detail" | "ticker" | "leaderboard" | "myBids";

export function SqlPeek({ name }: { name: ShapeName }) {
  const { data } = useQuery(orpc.meta.shapes.queryOptions());
  if (!data) return null;
  return (
    <details className="mt-8 text-xs text-slate-500">
      <summary className="cursor-pointer select-none hover:text-slate-300">
        The SQL behind this view
      </summary>
      <pre className="mt-2 overflow-x-auto rounded-md border border-slate-800 bg-slate-900 p-3 leading-relaxed text-sky-200">
        {data[name]}
      </pre>
    </details>
  );
}
