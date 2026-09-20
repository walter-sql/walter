import { ORPCError, os } from "@orpc/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "./auth";

export type Context = {
  req: IncomingMessage;
  res: ServerResponse;
  user: User | null;
};

export const pub = os.$context<Context>();

export const authed = pub.use(({ context, next }) => {
  if (!context.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { user: context.user } });
});
