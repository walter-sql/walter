import { createServer } from "node:http";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { sessionUser } from "./auth";
import { router } from "./router";

const handler = new RPCHandler(router, {
  interceptors: [onError(error => console.error(error))]
});
const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  const user = await sessionUser(req);
  const { matched } = await handler.handle(req, res, {
    prefix: "/rpc",
    context: { req, res, user }
  });
  if (!matched) {
    res.statusCode = 404;
    res.end();
  }
});

server.listen(port, () => {
  console.log(`demo server listening on :${port}`);
});
