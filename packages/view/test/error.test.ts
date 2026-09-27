import { it, expect } from "vitest";
import { WalterError } from "../src";

it("keeps the engine's text as the cause, never in the message", () => {
  const error = new WalterError("parse_error", {
    cause: "syntax error near SECRET"
  });
  expect(error.message).toBe(
    "[walter] parse_error: the engine could not parse this query"
  );
  expect(error.cause).toBe("syntax error near SECRET");
  expect("cause" in new WalterError("closed")).toBe(false);
});
