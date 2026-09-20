---
title: Data types
description: Map Postgres values to JSON and TypeScript, including exact numbers, timestamps, and parameters.
section: Reference
order: 2
---

Walter sends JSON rows. Some Postgres types are represented as strings so their values survive serialization without losing precision.

Use this table when defining an `EngineShape<TRow>` or interpreting a result in another language.

## Result values

| Postgres type                        | JSON representation           | Example                                  |
| ------------------------------------ | ----------------------------- | ---------------------------------------- |
| `smallint`, `integer`                | Number                        | `42`                                     |
| `bigint`                             | String                        | `"9007199254740993"`                     |
| `numeric` / `decimal`                | String                        | `"1234.56"`                              |
| `real`, `double precision`           | Number for finite values      | `1.5`                                    |
| Non-finite floats                    | String                        | `"NaN"`, `"Infinity"`, `"-Infinity"`     |
| `text`, `varchar`, `char` / `bpchar` | String                        | `"Review the migration"`                 |
| `boolean`                            | Boolean                       | `false`                                  |
| `uuid`                               | String                        | `"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"` |
| `json`, `jsonb`                      | JSON value                    | `{ "label": "review" }`                  |
| `bytea`                              | Hexadecimal text string       | `"\\x00ff"` in JSON                      |
| `date`                               | Date text                     | `"2026-09-14"`                           |
| `timestamp`                          | Timestamp text without a zone | `"2026-09-14 10:30:00.123456"`           |
| `timestamptz`                        | Timestamp text in UTC         | `"2026-09-14 10:30:00.123456+00"`        |
| SQL `NULL`                           | JSON null                     | `null`                                   |

The representations of typed SQL values also apply inside constructed JSON objects and nested collections.

Selecting a value does not imply that every Postgres operation on its type is supported. Check the [SQL reference](/docs/sql-support/) for comparisons, arithmetic, functions, and casts.

## JSON columns

You can select `json` and `jsonb` columns as values. When the value changes, Walter replaces the field. JSON extraction operators such as `->` and `->>`, and comparisons on JSON columns, are unsupported.

Numbers stored inside a JSON column use JSON's number representation and are subject to the parser's precision. They do not acquire the string representation used for typed `bigint` and `numeric` columns. For nested results built from related table rows, use the patterns in [Joins and nested results](/docs/relations/).

## Counts and exact numbers

Postgres returns a `bigint` from `count`, so `count(...)` is a string in a Walter result. Integer sums also return an exact string representation. For example:

```ts
type TaskSummary = {
  id: number;
  commentCount: string;
};
```

Use `BigInt` if you need integer arithmetic in JavaScript. Use a decimal library if you need exact decimal arithmetic on `numeric` values. Converting either type to `Number` can discard precision.

Walter supports exact addition, subtraction, and multiplication for integers and `numeric`. Integer division truncates toward zero. Division and remainder on `numeric` are unsupported; see [arithmetic and casts](/docs/sql-support/#arithmetic-and-casts) for alternatives and restrictions.

## Dates and timestamps

Walter keeps the text representation rather than constructing JavaScript `Date` objects. Its database sessions use UTC for `timestamptz` values and preserve Postgres's microsecond precision.

`timestamp` has no timezone. A value such as `"2026-09-14 10:30:00"` is a wall-clock time; do not assume it identifies an instant in the browser's local timezone.

Converting a timestamp through `Date` loses precision finer than a millisecond. For display, that may be acceptable. For cursors, comparisons, or round-tripping a value, preserve the original text. Postgres can also represent dates outside the range or formats accepted by JavaScript date utilities, including BC dates and infinity values.

## Parameter values

Parameters are JSON values in the `params` array. A comparison with a column normally gives a parameter its type. An explicit cast such as `$1::timestamptz` declares it when needed.

Pass large integers and exact decimals as strings. For time values, use ISO text and an explicit timezone offset for an instant, such as `"2026-09-14T10:30:00Z"`.

A zone-less bound compared with a `timestamptz` column is interpreted as UTC. A zoned bound compared with a `timestamp` column keeps the stated wall-clock time. Comparing a `date` or `timestamp` column directly with a `timestamptz` column is unsupported.

## Text behavior

Text comparisons and ordering use `COLLATE "C"` semantics rather than the database's default locale. `lower`, `upper`, and `ILIKE` use ASCII case folding. Account for this if you sort names or search multilingual text.

For a consolidated list of behavior that differs from direct Postgres results, see [Postgres differences](/docs/deviations/).
