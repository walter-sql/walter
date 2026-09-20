import type { WebSocket } from "ws";
import { log } from "../util/log";

const HIGH_WATER = 1 << 20;
const MAX_QUEUE = 10_000;

export class Sender {
  private readonly queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly ws: WebSocket) {}

  get depth(): number {
    return this.queue.length;
  }

  send(data: string): void {
    if (this.closed) return;
    if (this.queue.length > 0 || this.ws.bufferedAmount > HIGH_WATER) {
      this.queue.push(data);
      if (this.queue.length > MAX_QUEUE) {
        this.queue.length = 0;
        log.warn("closing connection: backpressure queue overflow");
        this.ws.close(1013, "backpressure: consumer too slow");
        return;
      }
      this.scheduleFlush();
    } else {
      this.ws.send(data);
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      while (this.queue.length > 0 && this.ws.bufferedAmount <= HIGH_WATER) {
        this.ws.send(this.queue.shift()!);
      }
      if (this.queue.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, 5);
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.queue.length = 0;
  }
}
