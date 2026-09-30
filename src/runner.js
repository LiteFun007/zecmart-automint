import { Client } from './http.js';
import { ServerClock, sleepUntilLocal } from './clock.js';
import { Store } from './state.js';
import { api, newIdempotencyKey } from './api.js';
import { runWallet, reconcile } from './worker.js';
import { log } from './log.js';

const fmtDelta = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

// Fetch that assumes failure is normal on this host. Returns null instead of
// throwing: nothing we read at startup is worth aborting a mint over.
async function insist(label, fn, { tries = 12, gapMs = 700, capMs = 3000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const res = await fn();
    if (res.ok && res.status === 200 && res.json) return res;
    log.warn(`${label} failed (${i}/${tries})`, { status: res.status, err: res.error, body: res.json?.error });
    await new Promise((r) => setTimeout(r, Math.min(capMs, gapMs * i)));
  }
  log.error(`${label} unavailable after ${tries} tries`);
  return null;
}

// launchAt is the only fact we genuinely cannot proceed without, so look for it
// in three independent places. The last one - the rejection body of a real mint
// POST - stays available even when every read endpoint is throwing 503, because
// the launch gate is checked before the database is touched.
async function discoverLaunchAt(client, cfg, mintConfig, store) {
  if (mintConfig?.launchAt) return { iso: mintConfig.launchAt, via: '/api/mint/config' };
  // A known-good launchAt in config beats spending scarce tokens rediscovering it.
  if (cfg.launchAtOverride) return { iso: cfg.launchAtOverride, via: 'config.launchAtOverride' };

  const l = await insist('GET /api/mint/launch', () => api.mintLaunch(client), { tries: 6 });
  if (l?.json?.launchAt) return { iso: l.json.launchAt, via: '/api/mint/launch' };

  if (cfg.wallets?.length) {
    log.warn('read endpoints are down - probing the mint endpoint itself for launchAt');
    const wallet = cfg.wallets[0];
    const key = `w:${wallet}`;
    // Seed the store with the key the probe will use, so that if the mint turns
    // out to be open and the probe mints for real, the worker for this wallet
    // replays the same key instead of burning a second slot - and the order is
    // already on disk either way.
    const idem = store.get(key)?.idempotencyKey || newIdempotencyKey();
    store.upsert(key, { wallet, idempotencyKey: idem, quantity: cfg.quantity, state: 'PENDING' });

    for (let i = 0; i < 4; i++) {
      const probe = await api.createOrder(client, { walletAddress: wallet, quantity: cfg.quantity, idempotencyKey: idem });
      if (probe.json?.launchAt) return { iso: probe.json.launchAt, via: 'MINT_NOT_STARTED probe' };
      const order = probe.json?.order || probe.json;
      if (probe.status >= 200 && probe.status < 300 && order?.id) {
        log.hit(`probe minted - the mint is already open (order ${order.id})`);
        store.upsert(key, {
          state: 'ORDERED', orderId: order.id, orderStatus: order.status,
          deliveryStatus: order.deliveryStatus, raw: order, attempts: 1
        });
        return { iso: new Date().toISOString(), via: 'already open', alreadyOpen: true };
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  if (cfg.launchAtOverride) return { iso: cfg.launchAtOverride, via: 'config.launchAtOverride' };
  return null;
}

export async function bootstrap(cfg, stateDir, { needConfig = true, needClock = true } = {}) {
  const client = new Client(cfg.baseUrl, cfg.network);
  await client.resolve();
  await client.warm();

  const res = needConfig ? await insist('GET /api/mint/config', () => api.mintConfig(client), { tries: cfg.network.bootstrapTries ?? 12 }) : null;

  const clock = new ServerClock(client);
  if (needClock) await clock.sync();

  return { client, clock, mintConfig: res?.json || null, store: new Store(stateDir) };
}

export function summariseTarget(mc) {
  if (!mc) {
    log.warn('running blind: /api/mint/config never answered, using config.json values only');
    return {};
  }
  const col = mc.collection || {};
  log.info('target collection', {
    name: col.name, slug: col.slug, supply: col.targetSupply,
    priceZec: col.priceZec, maxPerWallet: col.maxPerWallet, maxPerOrder: col.maxPerOrder,
    status: col.status, delivery: mc.delivery?.mode, network: mc.network
  });
  if (!mc.collection) {
    log.warn('/api/mint/config returned no collection block - the API shape may have changed');
  } else if (col.priceZatoshi !== '0') {
    log.error(`THIS MINT IS NOT FREE (${col.priceZec} ZEC). This tool only automates free mints; a paid mint needs a signed ZEC payment broadcast from Noir Wallet, which it deliberately does not do.`);
  }
  return col;
}

export async function run(cfg, stateDir, { rehearse = false, fireNow = false } = {}) {
  if (!cfg.wallets.length) throw new Error('no wallets configured - add addresses to wallets.txt');

  // Firing immediately needs no clock sync and no config read - both cost
  // scarce tokens and answer questions we are not asking.
  const { client, clock, mintConfig, store } = await bootstrap(cfg, stateDir, {
    needConfig: !fireNow, needClock: !fireNow
  });
  const col = summariseTarget(mintConfig);

  if (col.maxPerOrder && cfg.quantity > col.maxPerOrder) {
    log.warn(`quantity ${cfg.quantity} exceeds maxPerOrder ${col.maxPerOrder}, clamping`);
    cfg.quantity = col.maxPerOrder;
  }

  if (rehearse && mintConfig?.launchStarted) {
    throw new Error('refusing to rehearse: the mint has already started, a rehearsal post would mint for real');
  }

  let launchAtMs;
  if (fireNow) {
    launchAtMs = clock.now();
  } else {
    const found = await discoverLaunchAt(client, cfg, mintConfig, store);
    if (!found) {
      throw new Error('could not determine launchAt from any source - set "launchAtOverride" in config.json (ISO 8601) and re-run');
    }
    log.info(`launchAt ${found.iso} (via ${found.via})`);
    launchAtMs = Date.parse(found.iso);
    if (!Number.isFinite(launchAtMs)) throw new Error(`unparseable launchAt: ${found.iso}`);
    if (found.alreadyOpen) fireNow = true;
  }

  // Clock sync can only be as tight as the fastest RTT we observed, and this
  // host is slow, so we usually land at +/-1-2s. Start knocking that much early:
  // an early request just answers MINT_NOT_STARTED and costs one retry, while a
  // late one can miss a 555-piece free mint entirely.
  // Firing early costs a token for a guaranteed NOT_STARTED, and tokens are the
  // scarcest thing we have. With 555 free items and no hype, arriving a second
  // late is far cheaper than arriving early with an empty budget, so the early
  // push from clock uncertainty is capped hard.
  const effectiveLead = () => Math.max(-1000, Math.min(cfg.timing.leadMs, -Math.min(clock.uncertainty, 600)));

  const ctx = {
    cfg, client, clock, store,
    stopped: false,
    launchAtMs,
    ordered: new Set(),
    stop(reason) {
      if (this.stopped) return;
      this.stopped = true;
      log.warn(`stopping all workers: ${reason}`);
    },
    onOrder(w) { this.ordered.add(w); },
    counts: {},
    tick(outcome) { this.counts[outcome] = (this.counts[outcome] || 0) + 1; },
    rateLimited: 0,
    // This host rate-limits per IP, and a limited IP is a lost mint. If we start
    // collecting 429s, back the whole process off rather than digging in.
    noteRateLimit() {
      this.rateLimited++;
      if (this.rateLimited === 5 || this.rateLimited % 25 === 0) {
        log.error(`RATE LIMITED by the server (${this.rateLimited} times) - throttling down; lower network.globalRps if this persists`);
      }
      if (this.rateLimited === 5) {
        cfg.timing.hotRetryMs = Math.max(cfg.timing.hotRetryMs, 600);
        cfg.timing.maxInFlight = 1;
      }
    },
    noteLaunchAt(iso) {
      const t = Date.parse(iso);
      if (Number.isFinite(t) && Math.abs(t - this.launchAtMs) > 2000) {
        log.warn(`server moved launchAt to ${iso}`);
        this.launchAtMs = t;
        this.fireAtLocal = clock.localTimeFor(t + effectiveLead());
      }
    },
    retryDelay() {
      // Far from the target (launch pushed back): poll lazily instead of spinning.
      const until = this.launchAtMs - clock.now();
      if (until > 60000) return Math.min(15000, until / 4);
      const since = clock.now() - this.launchAtMs;
      return since < cfg.timing.hotWindowMs ? cfg.timing.hotRetryMs : cfg.timing.coolRetryMs;
    }
  };

  if (rehearse) {
    // Second guard, for the case where /api/mint/config was down and the
    // launchStarted flag above was never available: never rehearse past T0.
    if (clock.now() >= launchAtMs) {
      throw new Error('refusing to rehearse: launchAt has already passed, a rehearsal post would mint for real');
    }
    log.warn('REHEARSAL: firing the real request path now; the server should answer MINT_NOT_STARTED');
    ctx.fireAtLocal = Date.now();
    const probe = await api.createOrder(client, {
      walletAddress: cfg.wallets[0], quantity: cfg.quantity, idempotencyKey: `rehearse-${Date.now()}`
    });
    log.info('rehearsal response', { status: probe.status, body: probe.json || (probe.text || '').slice(0, 200), ms: +(probe.ms || 0).toFixed(0) });
    client.destroy();
    return;
  }

  ctx.fireAtLocal = fireNow ? Date.now() : clock.localTimeFor(launchAtMs + effectiveLead());
  if (!fireNow) {
    log.info(`fire scheduled ${Math.abs(effectiveLead())}ms before launchAt`, {
      launchAt: new Date(launchAtMs).toISOString(),
      fireAtLocal: new Date(ctx.fireAtLocal).toLocaleTimeString(),
      clockUncertaintyMs: clock.uncertainty
    });
  }

  if (!fireNow) await waitForLaunch(ctx);

  log.ok(`FIRING - ${cfg.wallets.length} wallet(s), quantity ${cfg.quantity} each`);

  const t0 = Date.now();
  // Heartbeat, so a long NOT_STARTED grind does not look like a hung process.
  const heartbeat = setInterval(() => {
    if (ctx.stopped) return;
    log.info(`t+${((Date.now() - t0) / 1000).toFixed(0)}s`, { ordered: ctx.ordered.size, ...ctx.counts });
  }, 10000);
  heartbeat.unref?.();

  try {
    await Promise.all(cfg.wallets.map((w, i) => runWallet(ctx, w, i).catch((e) => {
      log.error(`worker crashed for ${w.slice(0, 12)}…`, { err: String(e) });
    })));
  } finally {
    clearInterval(heartbeat);
  }
  log.info(`attempt phase done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (cfg.behaviour.confirmOrders) await reconcile(ctx);

  printSummary(store);
  client.destroy();
}

// Hold until T0. The hard constraint here is the server's per-IP request budget:
// it blocks after a handful of requests and 429s everything for ~30s+. So the
// plan is the opposite of "stay busy" - do all the expensive preparation early,
// then go completely silent so the budget refills to full, and arrive at T0 with
// every token available for actual mint POSTs.
async function waitForLaunch(ctx) {
  const { cfg, client, clock } = ctx;
  const quietMs = cfg.timing.quietBeforeMs;
  let prepared = false;
  let lastLog = 0;

  for (;;) {
    const remaining = ctx.fireAtLocal - Date.now();
    if (remaining <= 0) return;

    if (Date.now() - lastLog > (remaining > 120000 ? 60000 : 10000)) {
      lastLog = Date.now();
      log.info(`T-${fmtDelta(remaining)} until fire`, { budget: client.budgetLeft() });
    }

    // Final preparation: one precise clock sync and a fresh socket pool, done
    // far enough out that the budget has time to refill before we fire.
    if (!prepared && remaining <= cfg.timing.preOpenMs) {
      prepared = true;
      await clock.sync({ samples: 4, gapMs: 400 });
      ctx.fireAtLocal = clock.localTimeFor(ctx.launchAtMs + effectiveLead());
      await client.warm(cfg.network.warmSockets);
      log.info(`prepared; firing at ${new Date(ctx.fireAtLocal).toLocaleTimeString()} local`);
      continue;
    }

    // Radio silence. Sockets stay open on TCP keep-alive without costing budget.
    if (remaining <= quietMs) {
      log.info(`going quiet for ${(remaining / 1000).toFixed(1)}s to let the request budget refill`, {
        budget: client.budgetLeft()
      });
      await sleepUntilLocal(ctx.fireAtLocal);
      return;
    }

    // Outside the quiet window, a cheap poll for a moved launch time is worth
    // one token - but only occasionally.
    if (remaining > quietMs + 30000) {
      const r = await api.mintLaunch(client);
      if (r.json?.launchAt) ctx.noteLaunchAt(r.json.launchAt);
      if (r.json?.launchStarted === true) {
        log.warn('server reports launchStarted=true ahead of schedule - firing now');
        return;
      }
    }

    const nap = Math.min(30000, Math.max(500, (remaining - quietMs) / 3));
    await new Promise((r) => setTimeout(r, nap));
  }
}

export function printSummary(store) {
  const rows = store.all();
  const by = (s) => rows.filter((r) => r.state === s).length;
  log.info('---- summary ----');
  for (const r of rows) {
    log.info(`  ${r.wallet.slice(0, 14)}… ${r.state}${r.orderId ? ` order=${r.orderId}` : ''}${r.reason ? ` (${r.reason})` : ''}`, {
      qty: r.quantity, orderStatus: r.orderStatus, delivery: r.deliveryStatus, attempts: r.attempts
    });
  }
  log.ok(`confirmed=${by('CONFIRMED')} ordered=${by('ORDERED')} limit=${by('LIMIT')} failed=${by('ERROR') + by('FATAL') + by('DEAD')}`);
}
