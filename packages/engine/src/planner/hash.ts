import { createHash } from "node:crypto";
import { stableStringify } from "../ivm/zset";
import type { ShapeQuery } from "../parser/ir";

export function shapeFingerprint(
  shape: ShapeQuery,
  params: readonly unknown[]
): string {
  const h = createHash("sha256");
  h.update(stableStringify(shape as unknown));
  h.update("\u0000");
  h.update(JSON.stringify(params ?? []));
  return h.digest("hex").slice(0, 32);
}
