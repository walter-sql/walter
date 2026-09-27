---
title: Framework integrations
description: Add Walter to your existing server and frontend, using the transport that fits your application.
section: Build your app
order: 3
---

Start with the shared [client and query](/docs/your-app/), then choose your stack. Each recipe adds a subscription to an existing application.

## Choose a recipe

| Your stack                         | Example delivery to the browser                                  |
| ---------------------------------- | ---------------------------------------------------------------- |
| [oRPC](/docs/orpc-tanstack/)       | A typed stream over HTTP or WebSocket, with TanStack Query.      |
| [Express](/docs/express/)          | An SSE route using your existing session resolver.               |
| [Fastify](/docs/fastify/)          | An SSE response from an existing authenticated route.            |
| [Hono](/docs/hono/)                | An SSE response from an existing Node.js route.                  |
| [WebSocket / ws](/docs/websocket/) | Independent subscriptions on a shared application socket.        |
| [Socket.IO](/docs/socket-io/)      | Typed events, acknowledgements, and automatic reconnects.        |
| [tRPC](/docs/trpc/)                | A typed subscription over SSE or WebSocket, with TanStack Query. |
| [Node HTTP](/docs/other-stacks/)   | An SSE handler and a shared browser-consumption guide.           |

For a full-stack TypeScript app, oRPC and tRPC carry the declared row type through to the browser. Both support HTTP and WebSocket. Keep your existing framework if you already use one.

## Choose a transport

`EngineClient` runs in your application server. Its WebSocket connection to Walter reconnects automatically. Your server forwards results through the application's separate browser connection:

**SSE** sends updates from server to browser while writes use existing HTTP endpoints. Native `EventSource` reconnects automatically and uses cookies for authentication; it cannot set arbitrary headers.

**WebSocket** lets requests and updates share a persistent connection. Keep it if your app already has one. **Socket.IO** provides its own protocol over WebSocket or HTTP polling and requires its matching client.

## Authentication and cleanup

Authenticate on the server, cancel when the consumer leaves, and accept a fresh snapshot after reconnecting. The recipes handle delivery and cleanup; [access control](/docs/access-control/) covers permissions and [recovery](/docs/operations/) covers connection health.

Backend workers can consume `walter.stream` directly. Servers in other languages can use the [wire protocol](/docs/wire-protocol/).
