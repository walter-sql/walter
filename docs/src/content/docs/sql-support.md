---
title: SQL support
description: Supported SELECT constructs, expressions, functions, and restrictions to check when adapting a Postgres query.
section: Reference
order: 1
---

Walter supports a defined set of Postgres `SELECT` queries. A query that runs successfully in Postgres may still use constructs Walter cannot maintain.

The engine parses and plans a query when you subscribe. Unsupported constructs or parameter types are reported as `unsupported_sql`; invalid SQL syntax is reported as `parse_error`. A supported query can also fail while reading or evaluating data, in which case its subscription enters a [failed state](/docs/operations/#rejected-queries).

This reference describes support by construct. For query examples, start with [Queries and parameters](/docs/writing-shapes/). For differences from direct Postgres results, see [Postgres differences](/docs/deviations/).

## SELECT statements

| Construct                               | Support and restrictions                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SELECT`                                | One statement selecting from at least one table. No write statements or `SELECT INTO`.                                                              |
| Explicit columns and aliases            | Supported. Output names must be distinct; unknown or ambiguous column references are rejected.                                                      |
| `SELECT *`, `table.*`                   | Expanded using column definitions loaded from Postgres. Duplicate output names are rejected.                                                        |
| `WHERE`                                 | Supported with the expressions listed below.                                                                                                        |
| `GROUP BY`, `HAVING`                    | Supported. `HAVING` requires grouping or aggregates.                                                                                                |
| `ORDER BY`                              | Supported. Add a unique tie-breaker when stable display order matters.                                                                              |
| `LIMIT`, `OFFSET`                       | Integer literals or parameters. `LIMIT ALL` and a null limit mean no bound. Negative values are invalid.                                            |
| `DISTINCT`                              | Supported. `ORDER BY` expressions must be in the select list. `DISTINCT ON` is unsupported.                                                         |
| `WITH`                                  | Non-recursive SELECT CTEs referenced at most once can be inlined. Repeated references, recursive CTEs, and CTE column-alias lists are unsupported.  |
| Derived tables and lateral joins        | Some forms can be expanded into supported queries, including nesting patterns described below. Not every arbitrary subquery in `FROM` is supported. |
| `UNION`, `INTERSECT`, `EXCEPT`          | Unsupported.                                                                                                                                        |
| Window functions, `FETCH ... WITH TIES` | Unsupported.                                                                                                                                        |

The result size and the amount of data retained by the engine are different. Some queries with `LIMIT` still need all matching source rows. See [Memory and performance](/docs/performance/).

## Joins

| Construct                                           | Support and restrictions                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `INNER JOIN ... ON`, `LEFT JOIN ... ON`             | Supported with at least one column-equality condition. Composite keys and additional conditions are supported.                      |
| `RIGHT JOIN`                                        | Unsupported; express the query with a `LEFT JOIN` instead.                                                                          |
| `FULL OUTER JOIN`, `NATURAL JOIN`, `JOIN ... USING` | Unsupported. Use explicit `ON` conditions for supported joins.                                                                      |
| Self-joins                                          | The same table cannot appear twice at one query level. It can appear at different nesting levels, such as a parent and its replies. |
| Joins with only inequalities                        | Unsupported. A column-equality condition is required.                                                                               |

A join that can match several related rows produces several result rows. Use a nested aggregate if those rows should be one array within the parent. The [relations guide](/docs/relations/) shows both forms.

## Subqueries and nesting

| Construct                           | Support and restrictions                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correlated `EXISTS`, `NOT EXISTS`   | Use as a condition in `WHERE`, including an `AND` condition. The child reads one table, matches the parent by column equality, and can have its own filters. Joins, aggregates, grouping, and limits inside that `EXISTS` query are unsupported. |
| `IN (subquery)`, `= ANY (subquery)` | Converted to an existence check with the same restrictions. The left operand must be a qualified column.                                                                                                                                         |
| `NOT IN (subquery)`                 | Unsupported. Consider `NOT EXISTS`, accounting for the different null behavior.                                                                                                                                                                  |
| Correlated JSON collection subquery | Supported as a nested collection. The child query can use supported joins, filters, ordering, and limits.                                                                                                                                        |
| `LEFT JOIN LATERAL (...)`           | Supported for recognized nested-result patterns.                                                                                                                                                                                                 |
| Inline `json_agg` with `GROUP BY`   | Supported for recognized nested collections.                                                                                                                                                                                                     |
| Scalar JSON object subquery         | Requires a unique-key correlation or a limit of at most one row.                                                                                                                                                                                 |

Nested collection correlations must connect parent and child columns by equality, and the parent correlation columns must appear in the parent's select list. These forms are not a general implementation of arbitrary scalar subqueries.

## Aggregates

| Aggregate                           | Support and restrictions                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `count`, `sum`, `min`, `max`        | Supported. `count` and `sum` support `DISTINCT` and `FILTER`.                                                                                     |
| `sum(real)`                         | Unsupported; cast its argument to `float8`.                                                                                                       |
| `avg`                               | Supported for floats. For integer or `numeric` inputs, select `sum` and `count` separately or cast to `float8` if float precision is appropriate. |
| `json_agg`, `jsonb_agg`             | Supported as nested collections of objects, with child ordering and filtering. `DISTINCT` inside the JSON aggregate is unsupported.               |
| `array_agg(json_build_object(...))` | Recognized as a nested collection. General array aggregation is unsupported.                                                                      |
| Other aggregates                    | Unsupported, including `string_agg` and `bool_and`.                                                                                               |

Counts and exact numeric aggregates use [string representations](/docs/types/#counts-and-exact-numbers) in JSON. Floating-point aggregate behavior is described under [Postgres differences](/docs/deviations/#floating-point-aggregates).

## JSON construction

`json_build_object` and `jsonb_build_object` accept string-literal keys paired with values. They can describe a plain object value or a recognized nested relation. A to-one relation uses a unique key or `LIMIT 1` to establish that only one child can match.

Whole-row forms such as `json_agg(t)`, `to_jsonb(t)`, and `row_to_json(t)` are expanded to explicit fields. Missing joined rows and empty collections have the behavior described in [Postgres differences](/docs/deviations/#nested-results).

`json_build_array` is unsupported. JSON construction support does not imply support for JSON extraction operators such as `->` or `->>`.

## Conditions and expressions

Supported conditions include:

- Comparisons: `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`.
- Boolean expressions: `AND`, `OR`, `NOT`.
- Null tests: `IS NULL`, `IS NOT NULL`, `IS DISTINCT FROM`, `IS NOT DISTINCT FROM`.
- Boolean tests: `IS [NOT] TRUE`, `IS [NOT] FALSE`, `IS [NOT] UNKNOWN`.
- Text patterns: `LIKE`, `ILIKE`, using `COLLATE "C"` behavior and ASCII case folding for `ILIKE`.
- Value lists: `IN (...)`, `= ANY (...)`, `<> ALL (...)`. `ANY` and `ALL` accept an `ARRAY[...]` literal or an array-valued parameter.
- Ranges: `[NOT] BETWEEN`, including `SYMMETRIC`.
- `coalesce`.

`CASE`, arbitrary Postgres operators, and expressions not represented by the supported constructs are unsupported.

## Arithmetic and casts

Addition, subtraction, multiplication, unary negation, division, and remainder are supported for the applicable numeric types. Integer division truncates toward zero, and integer overflow raises an error. Division and remainder on `numeric` are unsupported. Floating-point remainder is not a Postgres operation.

A cast can either declare a parameter type or convert a supported expression:

| Cast                                               | Restrictions                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `$n::type`                                         | Declares the parameter's input type. The value must be valid for that type.                                   |
| `::smallint`, `::int`, `::bigint`                  | Require a numeric operand of known type and enforce the target's range.                                       |
| `::numeric`, `::text`, `::bool`                    | Supported for recognized conversions. Invalid input raises an error. Float-to-text conversion is unsupported. |
| `::float8`                                         | Supports numeric operands and constants. A text column must first be converted to `numeric`.                  |
| `::uuid`, `::date`, `::timestamp`, `::timestamptz` | Require a constant or a value already of that type.                                                           |
| Type modifiers and arrays                          | Casts such as `::numeric(10,2)` and array casts are unsupported.                                              |
| `::float4` and other targets                       | Unsupported.                                                                                                  |

Casting to `float8` changes the precision of a computation. Use it when a floating-point answer is appropriate, rather than as a general replacement for exact numeric arithmetic.

## Functions

| Function                | Notes                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| `lower`, `upper`        | ASCII case folding.                                                     |
| `length`, `char_length` | Character count.                                                        |
| `abs`, `round`          | Supported for their recognized numeric inputs.                          |
| `concat`                | Float arguments are unsupported, as with float-to-text casts.           |
| `coalesce`              | Supported; text conversions involving floats have the same restriction. |

Other functions are unsupported, including user-defined functions and time-dependent functions such as `now()`. To use a time bound, pass a timestamp parameter and open a new subscription when the bound should change. The passage of time alone does not change a fixed query parameter.

## Check an existing query

Test the SQL and parameter values your application actually sends. If it is rejected, the error identifies the unsupported construct or type. Reduce the query to its supported parts, then add joins, nesting, or expressions one at a time.

A successful TypeScript build checks your application types. It does not validate SQL or prove that an ORM-generated query is supported by Walter.
