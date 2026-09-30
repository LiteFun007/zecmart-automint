import { api, classify, newIdempotencyKey, OUTCOME, orderIsDead } from './api.js';
import { sleepUntilLocal } from './clock.js';
import { log } from './log.js';

const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Anything that is not "try again" tells us what happened to this wallet.
const DEFINITIVE = new Set([OUTCOME.SUCCESS, OUTCOME.NOT_STARTED, OUTCOME.SOLD_OUT, OUTCOME.WALLET_DONE, OUTCOME.FATAL]);

// Hedged request. The backend routinely takes 4-10s and drops ~1/3 of requests,
// so a single in-flight attempt spends most of the mint window waiting on a
// socket that may never answer. Instead we fire a second and third copy of the
// SAME request (same idempotency key, so the server collapses them into one
// order) once the first is clearly running late, and take the first real answer.
async function hedgedCreate(ctx, wallet, quantity, idem) {
  const { client, cfg } = ctx;
  const pending = new Set();
  let launched = 0;
  let last = null;

  const fire = () => {
    launched++;
    const entry = { n: launched };
    entry.p = api.createOrder(client, { walletAddress: wallet, quantity, idempotencyKey: idem })
      .then((res) => { entry.result = { res, cls: classify(res) }; return entry; });
    pending.add(entry);
    return entry;
  };

  fire();

  while (pending.size) {
    let timer;
    const hedge = new Promise((r) => { timer = setTimeout(() => r('HEDGE'), cfg.timing.hedgeAfterMs); });
    let winner;
    try {
      winner = await Promise.race([...[...pending].map((e) => e.p), hedge]);
    } finally {
      clearTimeout(timer);
    }

    if (winner === 'HEDGE') {
      if (pending.size < cfg.timing.maxInFlight) fire();
      continue;
    }

    pending.delete(winner);
    last = winner.result;
    if (DEFINITIVE.has(last.cls.outcome)) return { ...last, hedges: launched };
    // Transient. Let any siblings still in flight have their chance first.
    if (!pending.size) return { ...last, hedges: launched };
  }
  return last ? { ...last, hedges: launched } : { res: { ok: false }, cls: { outcome: OUTCOME.RETRY, reason: 'NO_RESULT' }, hedges: launched };
}

// One independent attempt loop per wallet. Wallets never share state except the
// global stop flag, so one wallet blowing up cannot take the others down.
export async function runWallet(ctx, wallet, index) {
  const { cfg, client, clock, store } = ctx;
  const tag = `${wallet.slice(0, 10)}…${wallet.slice(-4)}`;
  const key = `w:${wallet}`;

  let quantity = cfg.quantity;
  // ONE idempotency key for the whole run. If a request times out and actually
  // landed, re-posting the same key returns the existing order instead of
  // burning a second slot from a 2-per-wallet allowance.
  let idem = store.get(key)?.idempotencyKey || newIdempotencyKey();
  let downgraded = false;
  let attempts = 0;
  let consecutiveFailures = 0;
  let unknown = 0;

  store.upsert(key, { wallet, idempotencyKey: idem, quantity, state: 'PENDING' });

  // Stagger the opening volley so N wallets do not arrive as one spike.
  const startLocal = ctx.fireAtLocal + index * cfg.timing.spreadMs;
  await sleepUntilLocal(startLocal);

  const deadline = Date.now() + cfg.timing.maxRunMs;

  while (!ctx.stopped && Date.now() < deadline) {
    attempts++;
    const { res, cls, hedges } = await hedgedCreate(ctx, wallet, quantity, idem);

    ctx.tick(cls.outcome);
    log.debug(`${tag} attempt ${attempts} -> ${cls.outcome}`, {
      status: res.status, reason: cls.reason, hedges, ms: res.ms && +res.ms.toFixed(0)
    });

    switch (cls.outcome) {
      case OUTCOME.SUCCESS: {
        const o = cls.order;
        log.hit(`MINTED ${tag} qty=${quantity} order=${o.id}`, {
          status: o.status, delivery: o.deliveryStatus, attempts, replay: cls.reason === 'IDEMPOTENT_REPLAY'
        });
        store.upsert(key, {
          wallet, quantity, idempotencyKey: idem, state: 'ORDERED',
          orderId: o.id, orderStatus: o.status, deliveryStatus: o.deliveryStatus,
          attempts, raw: o
        });
        ctx.onOrder(wallet);
        return;
      }

      case OUTCOME.NOT_STARTED: {
        consecutiveFailures = 0;
        // The server echoes the authoritative launchAt on this error. If the team
        // pushes the launch back mid-run, follow it instead of spinning blindly.
        if (cls.launchAt) ctx.noteLaunchAt(cls.launchAt);
        await sleep(jitter(ctx.retryDelay()));
        break;
      }

      case OUTCOME.INDETERMINATE: {
        // The request may have created an order. Same key, short pause: the
        // retry either replays that order back to us or creates it properly.
        consecutiveFailures++;
        log.warn(`${tag} indeterminate (${cls.reason}), replaying same idempotency key`);
        await sleep(jitter(Math.min(1500, 120 * consecutiveFailures)));
        break;
      }

      case OUTCOME.WALLET_DONE: {
        // Could genuinely be the per-wallet cap, or just our quantity exceeding
        // maxPerOrder. Try once at qty 1 before writing the wallet off.
        if (!downgraded && quantity > 1) {
          downgraded = true;
          quantity = 1;
          idem = newIdempotencyKey();
          store.upsert(key, { quantity, idempotencyKey: idem });
          log.warn(`${tag} limit response (${cls.reason}), retrying at quantity=1`);
          await sleep(jitter(150));
          break;
        }
        log.warn(`${tag} finished: ${cls.reason}`);
        store.upsert(key, { state: 'LIMIT', reason: cls.reason, attempts });
        return;
      }

      case OUTCOME.SOLD_OUT: {
        log.error(`${tag} SOLD OUT (${cls.reason})`);
        store.upsert(key, { state: 'SOLD_OUT', reason: cls.reason, attempts });
        if (cfg.behaviour.stopOnSoldOut) ctx.stop('sold out');
        return;
      }

      case OUTCOME.FATAL: {
        log.error(`${tag} rejected: ${cls.reason} - check the address`);
        store.upsert(key, { state: 'FATAL', reason: cls.reason, attempts });
        return;
      }

      default: {
        consecutiveFailures++;
        unknown++;
        if (cls.reason === 'RATE_LIMITED') ctx.noteRateLimit();
        if (unknown === 1 || unknown % 10 === 0) {
          log.warn(`${tag} transient ${cls.reason}`, { status: res.status, snippet: cls.snippet, n: unknown });
        }
        if (unknown > cfg.behaviour.maxUnknownErrors) {
          log.error(`${tag} giving up after ${unknown} errors (last: ${cls.reason})`);
          store.upsert(key, { state: 'ERROR', reason: cls.reason, attempts });
          return;
        }
        // Throttling needs real silence, not a faster retry: this host only
        // clears a 429 after the IP stops talking for a while, so a tight retry
        // loop keeps the block alive forever (which is exactly what lost the
        // first attempt at this mint).
        const back = cls.throttled
          ? Math.min(cfg.timing.throttleBackoffMaxMs, cfg.timing.throttleBackoffMs * Math.min(consecutiveFailures, 4))
          : cls.backoff
            ? Math.min(5000, 200 * 2 ** Math.min(consecutiveFailures, 5))
            : ctx.retryDelay();
        if (cls.throttled) log.debug(`${tag} throttled - going silent for ${(back / 1000).toFixed(0)}s`);
        await sleep(jitter(back));
      }
    }
  }

  if (!ctx.stopped) {
    log.warn(`${tag} ran out of time after ${attempts} attempts`);
    store.upsert(key, { state: 'TIMEOUT', attempts });
  }
}

// After the dust settles, confirm every order actually reached a final state.
// A created order is not a delivered collectible.
export async function reconcile(ctx) {
  const { client, store, cfg } = ctx;
  const pending = store.all().filter((o) => o.orderId && o.state !== 'CONFIRMED');
  if (!pending.length) return;

  log.info(`reconciling ${pending.length} order(s)`);
  const until = Date.now() + 60000;

  while (Date.now() < until) {
    let outstanding = 0;
    for (const rec of store.all()) {
      if (!rec.orderId || rec.state === 'CONFIRMED') continue;
      const res = await api.getOrder(client, rec.orderId);
      const o = res.json?.order || res.json;
      if (!o?.id) { outstanding++; continue; }

      const patch = { orderStatus: o.status, deliveryStatus: o.deliveryStatus, raw: o };
      const done = String(o.status).toUpperCase() === 'COMPLETED' ||
                   String(o.deliveryStatus).toUpperCase() === 'DELIVERED' ||
                   String(o.deliveryStatus).toUpperCase() === 'NOT_REQUIRED';

      if (done) {
        store.upsert(rec.key, { ...patch, state: 'CONFIRMED' });
        log.ok(`confirmed ${rec.orderId}`, { status: o.status, delivery: o.deliveryStatus });
      } else if (orderIsDead(o)) {
        store.upsert(rec.key, { ...patch, state: 'DEAD' });
        log.error(`order ${rec.orderId} died: ${o.status}`);
      } else {
        store.upsert(rec.key, patch);
        outstanding++;
      }
    }
    if (!outstanding) return;
    await sleep(cfg.behaviour.reconcileIntervalMs);
  }
  log.warn('reconcile window closed with orders still in flight - see state/orders.json');
}
