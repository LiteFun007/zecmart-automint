import { randomUUID } from 'node:crypto';

export const newIdempotencyKey = () => `mint-${Date.now()}-${randomUUID()}`;

export const api = {
  mintConfig: (c) => c.get('/api/mint/config'),
  mintLaunch: (c) => c.get('/api/mint/launch'),
  mintStatus: (c) => c.get('/api/mint/status'),
  collections: (c) => c.get('/api/collections'),
  walletLimits: (c, w) => c.get(`/api/mint/wallet-limits?walletAddress=${encodeURIComponent(w)}`),
  getOrder: (c, id) => c.get(`/api/mint/orders/${encodeURIComponent(id)}`),
  createOrder: (c, { walletAddress, quantity, idempotencyKey }) =>
    c.post('/api/mint/orders', {
      body: { walletAddress, quantity, idempotencyKey },
      headers: { 'x-idempotency-key': idempotencyKey }
    })
};

// Outcome vocabulary the workers act on.
export const OUTCOME = {
  SUCCESS: 'SUCCESS',           // order exists, we are done for this wallet
  NOT_STARTED: 'NOT_STARTED',   // too early, hammer politely and keep going
  SOLD_OUT: 'SOLD_OUT',         // global stop
  WALLET_DONE: 'WALLET_DONE',   // per-wallet limit reached, stop this wallet
  FATAL: 'FATAL',               // bad input for this wallet, stop this wallet
  RETRY: 'RETRY',               // transient, new attempt with a fresh key is safe
  INDETERMINATE: 'INDETERMINATE' // request may have landed: retry the SAME key
};

const has = (s, ...needles) => needles.some((n) => s.includes(n));

// The server's exact error vocabulary is not documented, so classify defensively:
// match on what we have observed, pattern-match the rest, and default to "retry"
// rather than giving up on a wallet because of an unrecognised string.
export function classify(res) {
  if (!res.ok) {
    return { outcome: res.indeterminate ? OUTCOME.INDETERMINATE : OUTCOME.RETRY, reason: res.error };
  }

  const { status, json, text } = res;
  const code = String(json?.error || json?.code || '').toUpperCase();
  const msg = String(json?.message || '').toUpperCase();
  const blob = `${code} ${msg}`;

  // 2xx with an order id, or an idempotent replay of one we already created.
  const order = json?.order || json;
  if (status >= 200 && status < 300 && order?.id) return { outcome: OUTCOME.SUCCESS, order };

  if (status === 409 && order?.id) return { outcome: OUTCOME.SUCCESS, order, reason: 'IDEMPOTENT_REPLAY' };

  if (has(blob, 'NOT_STARTED', 'NOT_YET', 'COMING_SOON', 'NOT_OPEN')) {
    return { outcome: OUTCOME.NOT_STARTED, reason: code || 'NOT_STARTED', launchAt: json?.launchAt };
  }
  if (has(blob, 'SOLD_OUT', 'SUPPLY_EXHAUSTED', 'NO_ITEMS', 'NOTHING_AVAILABLE', 'OUT_OF_STOCK')) {
    return { outcome: OUTCOME.SOLD_OUT, reason: code || 'SOLD_OUT' };
  }
  // Throttling first: it is transient and must never be mistaken for a
  // per-wallet allowance being used up.
  if (status === 429 || has(blob, 'RATE_LIMIT', 'RATE_EXCEEDED', 'TOO_MANY')) {
    return { outcome: OUTCOME.RETRY, reason: 'RATE_LIMITED', backoff: true, throttled: true };
  }
  if (has(blob, 'MAX_PER_WALLET', 'ALREADY_MINTED', 'QUOTA', 'WALLET_LIMIT', 'LIMIT_REACHED', 'LIMIT_EXCEEDED')) {
    // A quantity cap is worth one retry at a lower quantity; the worker decides.
    return { outcome: OUTCOME.WALLET_DONE, reason: code || 'WALLET_LIMIT' };
  }
  if (has(blob, 'INVALID_WALLET', 'INVALID_ADDRESS', 'ADDRESS_NOT_SUPPORTED', 'MISSING_WALLET', 'UNSUPPORTED_NETWORK')) {
    return { outcome: OUTCOME.FATAL, reason: code || 'BAD_ADDRESS' };
  }
  if (has(blob, 'PAUSED', 'DISABLED', 'MAINTENANCE')) {
    // Paused is not final: launches get un-paused. Keep knocking.
    return { outcome: OUTCOME.NOT_STARTED, reason: code || 'PAUSED' };
  }

  // Observed repeatedly on this host before launch: the API answers 503
  // DATABASE_UNAVAILABLE at random. Always transient, always worth retrying.
  if (has(blob, 'DATABASE_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'UPSTREAM')) {
    return { outcome: OUTCOME.RETRY, reason: code || 'BACKEND_DOWN', backoff: true };
  }
  if (status >= 500) return { outcome: OUTCOME.RETRY, reason: `HTTP_${status}`, backoff: true };

  // HTML / empty body = CDN or proxy error page, i.e. the site fell over.
  if (!json) {
    const t = (text || '').toUpperCase();
    if (t.includes('RATE EXCEEDED') || t.includes('TOO MANY')) {
      return { outcome: OUTCOME.RETRY, reason: 'RATE_LIMITED', backoff: true, throttled: true };
    }
    return { outcome: OUTCOME.RETRY, reason: `HTTP_${status}_NON_JSON`, backoff: true, snippet: (text || '').slice(0, 120) };
  }

  if (status === 400 || status === 422) return { outcome: OUTCOME.RETRY, reason: code || `HTTP_${status}` };

  return { outcome: OUTCOME.RETRY, reason: code || `HTTP_${status}` };
}

// Does an order record represent a finished, owned mint?
export function orderIsComplete(o) {
  if (!o) return false;
  const st = String(o.status || '').toUpperCase();
  const dl = String(o.deliveryStatus || '').toUpperCase();
  return st === 'COMPLETED' || dl === 'DELIVERED' ||
         (st === 'PAYMENT_CONFIRMED' && dl === 'NOT_REQUIRED');
}

export function orderIsDead(o) {
  const st = String(o?.status || '').toUpperCase();
  return st === 'EXPIRED' || st === 'FAILED' || st === 'CANCELLED';
}
