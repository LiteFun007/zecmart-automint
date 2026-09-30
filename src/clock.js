import { log } from './log.js';

// Interval-narrowing clock sync against the server's Date header.
//
// A response carrying `Date: S` proves the server clock was in [S, S+1000) at
// some instant between our send (t0) and our receive (t1). That gives us
//     offset >= S - t1      and      offset < S + 1000 - t0
// Every sample tightens one side, so ~20 samples pin a 1-second-resolution
// header down to a few tens of milliseconds - far better than naive `S - now`.
export class ServerClock {
  constructor(client) {
    this.client = client;
    this.min = -Infinity;
    this.max = Infinity;
    this.offset = 0;
    this.uncertainty = 1000;
    this.samples = 0;
  }

  async sync({ samples = 8, gapMs = 220 } = {}) {
    // Reset the bracket: a previous sync may predate a clock/NTP adjustment.
    this.min = -Infinity;
    this.max = Infinity;
    this.samples = 0;

    // This API is slow and flaky (p50 ~4s, ~1/3 of responses are 503), so sample
    // in small parallel batches rather than serially - otherwise a single sync
    // takes minutes. A 503 still carries a usable Date header, so it counts.
    const batch = 2;
    for (let i = 0; i < samples && this.max - this.min >= 40; i += batch) {
      const probes = [];
      for (let k = 0; k < batch; k++) {
        const t0 = Date.now();
        probes.push(
          this.client.get('/api/mint/status', { timeoutMs: 6000 })
            .then((res) => ({ t0, t1: Date.now(), date: res.headers?.date }))
        );
      }
      for (const { t0, t1, date } of await Promise.all(probes)) {
        if (!date) continue;
        const S = Date.parse(date);
        if (!Number.isFinite(S)) continue;
        // A wide RTT only fails to tighten the bracket; it never corrupts it,
        // so every dated response is worth folding in.
        this.min = Math.max(this.min, S - t1);
        this.max = Math.min(this.max, S + 1000 - t0);
        this.samples++;
      }
      if (this.max - this.min < 40) break;
      await new Promise((r) => setTimeout(r, gapMs));
    }

    if (this.samples === 0 || !Number.isFinite(this.min) || !Number.isFinite(this.max)) {
      log.warn('clock sync got no usable samples, assuming local clock is correct');
      this.offset = 0;
      this.uncertainty = 1000;
      return this;
    }

    if (this.min > this.max) {
      // Server clock stepped mid-sync. Trust the newest half-bracket.
      log.warn('inconsistent clock bracket (server clock stepped?), widening');
      this.offset = (this.min + this.max) / 2;
      this.uncertainty = 500;
    } else {
      this.offset = Math.round((this.min + this.max) / 2);
      this.uncertainty = Math.round((this.max - this.min) / 2);
    }

    log.ok(`clock synced: offset ${this.offset > 0 ? '+' : ''}${this.offset}ms (±${this.uncertainty}ms)`, {
      samples: this.samples
    });
    return this;
  }

  now() { return Date.now() + this.offset; }

  // Local timestamp at which the server clock will read `serverMs`.
  localTimeFor(serverMs) { return serverMs - this.offset; }

  msUntil(serverMs) { return serverMs - this.now(); }
}

// setTimeout drifts and oversleeps. Sleep coarsely, then spin the last ~25ms
// so the first request leaves the process within a couple of milliseconds of target.
export async function sleepUntilLocal(targetLocalMs) {
  for (;;) {
    const remaining = targetLocalMs - Date.now();
    if (remaining <= 0) return;
    if (remaining > 250) await new Promise((r) => setTimeout(r, remaining - 200));
    else if (remaining > 25) await new Promise((r) => setTimeout(r, 5));
    else await new Promise((r) => setImmediate(r));
  }
}
