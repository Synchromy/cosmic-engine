import type { OperationDeliveryEffect } from './ops/contract.ts';

export const MAX_OPERATION_EFFECTS = 4;
export const MAX_TRACKED_EFFECTS = 64;

/** Optional best-effort work after definitive authorization. Capture only necessary effect state. */
export class OperationDeliveryEffects {
  private closed = false;
  private readonly pending = new Map<Promise<void>, AbortController>();
  constructor(private readonly waitMs: number, private readonly report: () => void) {}
  get pendingCount(): number { return this.pending.size; }
  private failed(): void { try { this.report(); } catch { /* static reporting is best-effort */ } }
  enqueue(effects: readonly OperationDeliveryEffect[]): void {
    for (const effect of effects) {
      if (this.closed || this.pending.size >= MAX_TRACKED_EFFECTS) { this.failed(); continue; }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        this.failed();
        // Keep the slot until underlying work settles, even if it ignores abort.
      }, this.waitMs);
      const work = Promise.resolve().then(async () => {
        if (!controller.signal.aborted) await effect(controller.signal);
      }).catch(() => { if (!timedOut) this.failed(); }).finally(() => {
        clearTimeout(timer);
        this.pending.delete(work);
      });
      this.pending.set(work, controller);
    }
  }
  stop(): void {
    this.closed = true;
    for (const controller of this.pending.values()) controller.abort();
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.keys()]); }
}
