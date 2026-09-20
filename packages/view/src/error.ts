import type { ErrorMsg } from "./protocol";

export class WalterError extends Error {
  override readonly name = "WalterError";

  constructor(
    readonly code: ErrorMsg["code"] | "failed" | "closed",
    message: string
  ) {
    super(`[walter] ${code}: ${message}`);
  }

  static failed = () =>
    new WalterError(
      "failed",
      "the engine could not compute this query; the cause is in its log"
    );
  static closed = () =>
    new WalterError("closed", "the stream ended without being cancelled");
}
