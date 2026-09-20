import { pino } from "pino";

export const log = pino({
  name: "walter",
  level: process.env.WALTER_LOG ?? "info"
});
