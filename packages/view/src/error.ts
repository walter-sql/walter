import type { ErrorMsg } from "./protocol";

const MESSAGES: Record<ErrorMsg["code"] | "failed" | "closed", string> = {
  bad_message: "the engine rejected a malformed message",
  unsupported_sql: "the engine does not support this query",
  parse_error: "the engine could not parse this query",
  internal: "the engine hit an internal error",
  failed: "the engine could not compute this query; the cause is in its log",
  closed: "the stream ended without being cancelled"
};

export class WalterError extends Error {
  override readonly name = "WalterError";

  constructor(
    readonly code: keyof typeof MESSAGES,
    options?: ErrorOptions
  ) {
    super(`[walter] ${code}: ${MESSAGES[code]}`, options);
  }
}
