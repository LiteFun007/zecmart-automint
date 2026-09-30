import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import { log } from './log.js';

// Token bucket sized to the server's OWN per-IP window, not to a speed we would
// like. This host blocks an IP after a handful of requests and returns 429 for
// everything, so the budget is the scarcest resource in the whole mint: every
// request spent on polling is a request not available for an actual mint POST.
//
// capacity = windowBudget, refill = windowBudget per windowMs. Staying quiet
// lets the bucket refill to full, which is exactly what we want going into T0.
class Limiter {
  constructor({ windowBudget, windowMs }) {
    this.capacity = windowBudget;
    this.windowMs = windowMs;
    this.tokens = windowBudget;
    this.last = Date.now();
    this.spent = 0;
  }
  ratePerMs() { return this.capacity / this.windowMs; }
  available() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.ratePerMs());
    this.last = now;
    return this.tokens;
  }
  async take() {
    for (;;) {
      if (this.available() >= 1) { this.tokens -= 1; this.spent++; return; }
      const waitMs = Math.max(20, (1 - this.tokens) / this.ratePerMs());
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 2000)));
    }
  }
}

export class Client {
  constructor(baseUrl, netCfg) {
    this.base = new URL(baseUrl);
    this.cfg = netCfg;
    this.secure = this.base.protocol === 'https:';
    this.mod = this.secure ? https : http;
    this.ips = [];
    this.rr = 0;
    this.limiter = new Limiter({ windowBudget: netCfg.windowBudget, windowMs: netCfg.windowMs });

    // Pinned DNS: resolution happens once, during warm-up, never on the hot path.
    const lookup = (hostname, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      const options = typeof opts === 'function' ? {} : (opts || {});
      const deliver = (list) => {
        if (options.all) return done(null, list);
        done(null, list[0].address, list[0].family);
      };
      if (!this.ips.length) {
        return dns.lookup(hostname, { all: true }).then(
          (list) => (list?.length ? deliver(list) : done(new Error('EAI_NODATA'))),
          (e) => done(e)
        );
      }
      // Round-robin the cached records so sockets spread across edge IPs.
      const start = this.rr++ % this.ips.length;
      const ordered = this.ips.slice(start).concat(this.ips.slice(0, start));
      deliver(ordered);
    };

    this.agent = new this.mod.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: netCfg.maxSockets,
      maxFreeSockets: netCfg.maxSockets,
      scheduling: 'fifo',
      timeout: netCfg.connectTimeoutMs,
      lookup
    });
  }

  async resolve() {
    try {
      const recs = await dns.lookup(this.base.hostname, { all: true });
      this.ips = recs.filter((r) => r.family === 4).concat(recs.filter((r) => r.family === 6));
      log.debug('dns resolved', { host: this.base.hostname, ips: this.ips.map((i) => i.address) });
    } catch (e) {
      log.warn('dns pre-resolve failed, falling back to per-request lookup', { err: String(e) });
    }
  }

  budgetLeft() { return Math.floor(this.limiter.available()); }
  budgetSpent() { return this.limiter.spent; }

  // Never throws. Returns a uniform envelope so callers classify instead of
  // try/catch-ing around an unpredictable stack of failure modes.
  request(method, pathname, { body = null, headers = {}, timeoutMs, limited = true } = {}) {
    const t0 = process.hrtime.bigint();
    const run = () => new Promise((resolve) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const opts = {
        method,
        host: this.base.hostname,
        port: this.base.port || (this.secure ? 443 : 80),
        path: pathname,
        agent: this.agent,
        servername: this.secure ? this.base.hostname : undefined,
        headers: {
          host: this.base.host,
          accept: 'application/json, text/plain, */*',
          'accept-encoding': 'identity',
          'user-agent': this.cfg.userAgent,
          origin: this.base.origin,
          referer: this.base.origin + '/launchpad',
          connection: 'keep-alive',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...headers
        }
      };

      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        res.ms = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve(res);
      };

      const req = this.mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          const ct = res.headers['content-type'] || '';
          if (ct.includes('json')) { try { json = JSON.parse(text); } catch {} }
          // A non-JSON body here means a proxy/CDN error page, not the API.
          finish({ ok: true, status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', (err) => finish({ ok: false, status: 0, error: 'RESPONSE_ERROR', detail: String(err) }));
      });

      req.setNoDelay(true);
      req.setTimeout(timeoutMs ?? this.cfg.requestTimeoutMs, () => {
        req.destroy();
        // Timeout is the dangerous case: the request may or may not have landed.
        finish({ ok: false, status: 0, error: 'TIMEOUT', indeterminate: true });
      });
      req.on('error', (err) => {
        const code = err.code || 'NETWORK';
        // If the socket died after we finished writing, the server may still have
        // processed it. Flag it so the caller reuses its idempotency key.
        finish({ ok: false, status: 0, error: code, detail: String(err), indeterminate: code === 'ECONNRESET' });
      });

      if (payload) req.write(payload);
      req.end();
    });

    return limited ? this.limiter.take().then(run) : run();
  }

  get(p, o) { return this.request('GET', p, o); }
  post(p, o) { return this.request('POST', p, o); }

  // Force N live TLS connections so no handshake sits on the critical path at T0.
  async warm(n = this.cfg.warmSockets) {
    const jobs = [];
    // Staggered, not a burst: a simultaneous fan-out is what trips the per-IP
    // rate limiter on this host, and a 429'd IP at T0 loses the mint outright.
    for (let i = 0; i < n; i++) {
      jobs.push(new Promise((r) => setTimeout(r, i * 150)).then(() => this.get('/api/mint/status')));
    }
    const res = await Promise.all(jobs);
    const good = res.filter((r) => r.ok && r.status === 200).length;
    log.info(`warmed ${good}/${n} connections`, { avgMs: +(res.reduce((a, r) => a + r.ms, 0) / n).toFixed(1) });
    return good;
  }

  destroy() { this.agent.destroy(); }
}
