import type { ThrottleStatus } from './types.js';

export interface RateLimiterOptions {
  /** Fraction of the bucket held back as headroom for other clients. */
  reserveRatio?: number;
  /** Cost assumed before any response has been observed. */
  initialCostEstimate?: number;
  /** How many recent costs feed the rolling average. */
  costWindow?: number;
  /** Hard ceiling on a single computed wait, in ms. */
  maxWaitMs?: number;
  label?: string;
}

export interface LimiterSnapshot {
  available: number;
  maximum: number;
  restoreRate: number;
  estimatedCost: number;
  inFlight: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private maximum: number | null = null;
  private restoreRate: number | null = null;
  private lastAvailable: number | null = null;
  private lastObservedAt = 0;

  private recentCosts: number[] = [];
  private inFlight = 0;
  private reservedPoints = 0;

  private queue: Promise<void> = Promise.resolve();

  private readonly reserveRatio: number;
  private readonly initialCostEstimate: number;
  private readonly costWindow: number;
  private readonly maxWaitMs: number;
  private readonly label: string;

  constructor(options: RateLimiterOptions = {}) {
    this.reserveRatio = options.reserveRatio ?? 0.2;
    this.initialCostEstimate = options.initialCostEstimate ?? 50;
    this.costWindow = options.costWindow ?? 20;
    this.maxWaitMs = options.maxWaitMs ?? 60_000;
    this.label = options.label ?? 'shopify';
  }

  /** Points available right now, extrapolating refill since the last reading. */
  private projectedAvailable(): number | null {
    if (
      this.lastAvailable === null ||
      this.restoreRate === null ||
      this.maximum === null
    ) {
      return null;
    }

    const elapsedSeconds = (Date.now() - this.lastObservedAt) / 1000;
    const restored = elapsedSeconds * this.restoreRate;

    const projected = Math.min(this.maximum, this.lastAvailable + restored);

    return Math.max(0, projected - this.reservedPoints);
  }

  private estimatedCost(): number {
    if (this.recentCosts.length === 0) return this.initialCostEstimate;

    const total = this.recentCosts.reduce((sum, c) => sum + c, 0);
    const mean = total / this.recentCosts.length;
    const peak = Math.max(...this.recentCosts);

    // Bias toward the peak — underestimating causes throttles.
    return Math.ceil((mean + peak) / 2);
  }

  private floor(): number {
    if (this.maximum === null) return 0;
    return this.maximum * this.reserveRatio;
  }

  /**
   * Waits until the projected bucket can absorb the estimated cost,
   * then reserves those points for the caller.
   * Serialized so concurrent callers cannot both see the same headroom.
   */
  async acquire(): Promise<void> {
    const run = this.queue.then(() => this.waitForCapacity());
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async waitForCapacity(): Promise<void> {
    const cost = this.estimatedCost();

    for (;;) {
      const available = this.projectedAvailable();

      // No reading yet — let the first request through to learn the shape.
      if (available === null) break;

      const usable = available - this.floor();

      if (usable >= cost) break;

      if (this.restoreRate === null || this.restoreRate <= 0) break;

      const deficit = cost - usable;
      const waitMs = Math.min(
        this.maxWaitMs,
        Math.ceil((deficit / this.restoreRate) * 1000) + 50
      );

      console.warn(
        `[limiter:${this.label}] need ${cost}, have ${Math.floor(usable)} ` +
          `— waiting ${waitMs}ms`
      );

      await sleep(waitMs);
    }

    this.reservedPoints += cost;
    this.inFlight += 1;
  }

  /** Releases the reservation. Always call this, success or failure. */
  release(): void {
    const cost = this.estimatedCost();
    this.reservedPoints = Math.max(0, this.reservedPoints - cost);
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Feeds a real reading back in. Trust this over any projection. */
  record(status: ThrottleStatus, actualCost?: number): void {
    this.maximum = status.maximumAvailable;
    this.restoreRate = status.restoreRate;
    this.lastAvailable = Math.min(
      status.currentlyAvailable,
      status.maximumAvailable
    );
    this.lastObservedAt = Date.now();

    if (typeof actualCost === 'number' && actualCost > 0) {
      this.recentCosts.push(actualCost);
      if (this.recentCosts.length > this.costWindow) {
        this.recentCosts.shift();
      }
    }
  }

  /** Called on a THROTTLED response — the bucket is empty regardless of reading. */
  markThrottled(status?: ThrottleStatus): void {
    if (status) {
      this.record(status);
      this.lastAvailable = 0;
      this.lastObservedAt = Date.now();
      return;
    }

    this.lastAvailable = 0;
    this.lastObservedAt = Date.now();
  }

  /** Milliseconds until `points` are expected to be available. */
  waitTimeFor(points: number): number {
    const available = this.projectedAvailable();
    if (available === null || this.restoreRate === null) return 1000;

    const deficit = points - (available - this.floor());
    if (deficit <= 0) return 0;

    return Math.min(this.maxWaitMs, Math.ceil((deficit / this.restoreRate) * 1000));
  }

  /** Concurrency this bucket can sustain, derived from capacity not guesswork. */
  suggestedConcurrency(): number {
    if (this.maximum === null || this.restoreRate === null) return 2;

    const cost = this.estimatedCost();
    const sustainable = this.restoreRate / cost;

    return Math.max(1, Math.min(20, Math.floor(sustainable)));
  }

  snapshot(): LimiterSnapshot {
    return {
      available: Math.floor(this.projectedAvailable() ?? 0),
      maximum: this.maximum ?? 0,
      restoreRate: this.restoreRate ?? 0,
      estimatedCost: this.estimatedCost(),
      inFlight: this.inFlight,
    };
  }
}