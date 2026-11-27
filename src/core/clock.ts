// Injectable clock so scheduling, leases and usage-reset logic are testable deterministically.
export interface Clock {
  now(): number; // epoch milliseconds
}
export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private t: number = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}
