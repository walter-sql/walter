import type { QueryFunction, QueryKey } from "@tanstack/query-core";
import {
  WalterError,
  materialize,
  snapshot,
  type RowValue,
  type ViewMessage
} from "@walter-sql/view";

export * from "@walter-sql/view";

type StreamQueryFn<
  TRow extends RowValue,
  TQueryKey extends QueryKey
> = QueryFunction<AsyncIterable<ViewMessage<TRow>>, TQueryKey>;

export function liveQueryFn<
  TRow extends RowValue,
  TQueryKey extends QueryKey = QueryKey
>(queryFn: StreamQueryFn<TRow, TQueryKey>): QueryFunction<TRow[], TQueryKey> {
  return async context => {
    const { client, queryKey } = context;
    const query = client.getQueryCache().find({ queryKey, exact: true })!;
    let rows: TRow[] = [];
    for await (const view of materialize(await queryFn(context))) {
      rows = view.rows;
      if (view.status === "failed")
        query.setState({ status: "error", error: WalterError.failed() });
      else client.setQueryData<TRow[]>(queryKey, rows);
    }
    if (!context.signal.aborted) throw WalterError.closed();
    return rows;
  };
}

export function liveQueryOptions<
  TRow extends RowValue,
  TQueryKey extends QueryKey,
  TOptions extends { queryKey: TQueryKey }
>(
  options: TOptions & { queryFn: StreamQueryFn<TRow, TQueryKey> }
): Omit<TOptions, "queryFn"> & { queryFn: QueryFunction<TRow[], TQueryKey> } {
  const { queryFn, ...base } = options;
  return {
    refetchOnMount: "always",
    retry: true,
    ...base,
    queryFn: liveQueryFn(queryFn)
  };
}

export function snapshotQueryOptions<
  TRow extends RowValue,
  TQueryKey extends QueryKey,
  TOptions extends { queryKey: TQueryKey }
>(
  options: TOptions & { queryFn: StreamQueryFn<TRow, TQueryKey> }
): Omit<TOptions, "queryFn"> & { queryFn: QueryFunction<TRow[], TQueryKey> } {
  const { queryFn, ...base } = options;
  return {
    ...base,
    queryFn: async context => snapshot(await queryFn(context))
  };
}
