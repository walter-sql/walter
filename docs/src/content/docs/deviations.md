---
title: Postgres differences
description: Differences in text comparison, nested results, numeric aggregation, and Postgres version support.
section: Reference
order: 3
---

Walter uses Postgres SQL syntax, but it evaluates query results in its own engine and sends them as JSON. Some behavior differs from running the original query directly in Postgres.

This page lists differences to account for when checking results and declaring application types. Unsupported constructs are listed separately in [SQL support](/docs/sql-support/).

## Text comparison

Walter compares and orders text with `COLLATE "C"` semantics. Your database's default collation may order text differently. `lower`, `upper`, and the case-insensitive part of `ILIKE` use ASCII case folding.

For example, do not assume that an accented uppercase character matches its lowercase counterpart under `ILIKE`, or that a list of names will follow a locale-specific alphabetic order. If your application depends on that behavior, test it explicitly.

## Values inside JSON

Walter uses the same value representations at every nesting depth:

- `bigint` and `numeric` values are strings, including counts and numeric aggregates.
- Dates and timestamps use Postgres text forms; `timestamptz` values use UTC.
- Non-finite float values are strings: `"NaN"`, `"Infinity"`, and `"-Infinity"`.

Postgres's JSON constructors can instead turn exact numeric values into JSON numbers and format timestamps with a `T` separator. Walter preserves its own wire representations inside nested objects and arrays too.

Use the representations in [Data types](/docs/types/) for application row types. Parsing a large integer or high-precision decimal as a JavaScript number can lose information.

## Nested results

A recognized nested collection is an array, including `[]` when no child rows match. Bare `json_agg` in Postgres returns `NULL` for no rows. The query guides use `coalesce(json_agg(...), '[]')` to make the empty-array intent explicit in SQL.

A recognized to-one relation is an object or `null`. For instance, the assignee object in the [nested results guide](/docs/relations/#return-a-related-object) is `null` when the left join has no matching user. A direct Postgres `json_build_object` over those null columns can produce an object containing null-valued fields instead.

Whole-row JSON has a separate case: outside a recognized to-one relation, a missing side of a left join can become an object with null fields in Walter where Postgres returns `NULL` for the whole row. Check missing relationships as well as populated ones when adapting SQL that constructs JSON.

## Floating-point aggregates

Postgres accumulates floating-point sums in scan order. Rounding can therefore depend on the order in which the rows are processed.

Walter accumulates an exact sum of the floating-point inputs and rounds the result once. `sum` and `avg` can differ from Postgres in the final rounding or in whether intermediate accumulation overflows. This is a difference to consider in applications that compare floating-point results exactly.

`sum(real)` is unsupported. Cast the input to `float8` to use a floating-point sum. For exact decimal values, use supported `numeric` operations instead; `avg(numeric)` is not currently supported.

## Generated columns

Stored generated columns can be published on Postgres 18, and Walter enables that publication option. On earlier versions they are not available to subscription queries.

Virtual generated columns cannot be delivered through logical replication. Walter rejects startup if a served table contains them. [Installation](/docs/installation/#generated-columns-and-partitions) explains this restriction and how to exclude such tables.

## Numeric parameter spelling

A string parameter such as `"1_000"` used in a numeric arithmetic expression may be sent to Postgres as written. That spelling requires Postgres 18's numeric input behavior. Use `"1000"` for compatibility with older supported versions.

Numeric literals written directly in SQL are parsed separately from parameter values. Do not assume that every accepted SQL literal spelling is also accepted as a string parameter on every server version.
