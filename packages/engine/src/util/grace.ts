export class GraceMap {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ttlMs: number) {}

  schedule(key: string, drop: () => void): void {
    this.cancel(key);
    if (this.ttlMs <= 0) {
      drop();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      drop();
    }, this.ttlMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
