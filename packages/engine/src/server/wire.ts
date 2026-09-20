import { z } from "zod";
import type { ClientMessage, ServerMessage } from "@walter-sql/view";

const inbound: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    shapeId: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional()
  }),
  z.object({ type: z.literal("unsubscribe"), shapeId: z.string() })
]);

export function parseClientMessage(
  raw: string
): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const result = inbound.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map(i => i.message).join("; ")
    };
  }
  return { ok: true, msg: result.data };
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export const snapshotFrame = (shapeId: string, rows: string) =>
  `{"type":"snapshot","shapeId":${JSON.stringify(shapeId)},"rows":${rows}}`;

export const diffFrame = (shapeId: string, changes: string) =>
  `{"type":"diff","shapeId":${JSON.stringify(shapeId)},"changes":${changes}}`;
