import {
  createRootRoute,
  createRoute,
  createRouter
} from "@tanstack/react-router";
import { Layout } from "./layout";
import { AuctionPage } from "./routes/auction";
import { MyBidsPage } from "./routes/bids";
import { BoardPage } from "./routes/board";
import { LeaderboardPage } from "./routes/leaderboard";

const rootRoute = createRootRoute({ component: Layout });

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: BoardPage
});

const auctionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lot/$auctionId",
  component: AuctionPage
});

const leaderboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/leaderboard",
  component: LeaderboardPage
});

const myBidsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bids",
  component: MyBidsPage
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    boardRoute,
    auctionRoute,
    leaderboardRoute,
    myBidsRoute
  ])
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
