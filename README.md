# zecmart-automint

A client that has to land an HTTP request inside a window it does not control,
against a backend that fails a third of the time, through a rate limit narrow
enough that *every poll is a request you will not have at T0*.

Node.js ≥ 20. **Zero dependencies** — no HTTP client, no scheduler, no retry
library. Everything below is in `src/`, about a thousand lines.

Ukrainian original, with the full measurement log: [README.uk.md](README.uk.md).

---

## Why it is built this way

The architecture is not a guess. It follows from six things measured against the
live API before any of it was written.

**1. No wallet signature is needed.** Creating an order is a plain
`POST /api/mint/orders` with `{walletAddress, quantity, idempotencyKey}` — no
auth, no signature, no transaction. The browser wallet exists only so the
frontend can read an address. So this is an HTTP client, not a browser
automation, and it is an order of magnitude faster and steadier for it.

**2. The rate limit is global, not per-endpoint.** A handful of requests and
*everything* returns `429 Rate exceeded`, including the mint endpoint itself.
Recovery takes 15–35 s. Measured: four endpoints at one request each, 700 ms
apart, passed on the first round and collapsed into 429 on the second.

That single fact drives the whole design. Request budget — not bandwidth, not
concurrency — is the scarce resource.

**3. The backend is unreliable under no load at all.** 24 sequential requests,
idle system:

```
success:     67%    (rest: 503 DATABASE_UNAVAILABLE, TIMEOUT, ECONNRESET)
latency:     p50 4.3s   p90 9.1s   max 13.6s
```

It will be worse at launch. "Send the request and wait" is therefore not a
strategy.

**4. Being early is cheap.** `409 MINT_NOT_STARTED` comes back in 130–290 ms —
the time check runs before the database is touched — and its body carries an
authoritative `launchAt`. Knocking early costs almost nothing and tells you the
truth about the server's clock.

**5. Collection limits:** `maxPerWallet: 2`, `maxPerOrder: 2`. One request per
wallet with `quantity: 2` takes the entire allowance. Extra requests from the
same address buy nothing.

---

## How each problem is solved

| Problem | Mechanism |
| --- | --- |
| Client clock ≠ server clock | Interval-narrowing off the `Date` header. Each response proves server time lay in `[S, S+1000)` between send and receive; ~24 samples squeeze one-second granularity down to an error equal to the fastest round trip. |
| Sync is still bounded by latency (±1–2 s) | The start is shifted earlier automatically by `-(error + 1000 ms)`. One early request costs a retry; one late request costs the mint. |
| A request hangs for 10+ s | **Hedged requests** — no answer within `hedgeAfterMs` and a second, then third, copy of *the same* request goes out in parallel. First real response wins. |
| Hedged copies could create two orders | **One idempotency key per wallet for the whole run**, persisted to disk. A repeat with the same key returns the existing order, never a new one. |
| A timeout means the request may or may not have landed | Classified separately as `INDETERMINATE` and retried with the same key. It never burns the second of the two allowed slots. |
| 503, or a CDN HTML error page | The classifier does not assume JSON, treats a non-JSON body as transient, and backs off exponentially. |
| An unrecognised error code | **Retry by default.** A wallet is only given up on an explicit `SOLD_OUT`, a limit hit, or an invalid address. |
| The launch time moves | `launchAt` is re-read while waiting and taken from the body of every `MINT_NOT_STARTED` refusal. The schedule recomputes in flight. |
| The process dies mid-mint | Every state change is written and `fsync`-ed to `state/orders.json`. Idempotency keys are picked back up on restart. |
| DNS or TLS on the critical path | The IP is resolved once in advance; a keep-alive pool is warmed before the start, and again 3 s out. |
| The IP rate limit eats the mint | A token bucket calibrated to the **server's window** rather than a desired rate: `windowBudget` requests per `windowMs`, with capacity equal to the window budget — so silence accumulates tokens. |
| Warm-up burns the budget it was meant to protect | **Radio silence for the last 45 s.** Clock sync and socket warming happen ~2.5 minutes out, then nothing is sent, so the budget refills to full. Sockets are held open by TCP keep-alive, not by HTTP pings. |
| The server starts returning 429 anyway | After five 429s the client lowers its own rate and switches parallel copies off. |
| `setTimeout` drifts by tens of milliseconds | The final 25 ms is a busy wait on `setImmediate`. |

Every address runs as an independent worker. One wallet failing or being banned
does not affect the others.

---

## Layout

| File | Role |
| --- | --- |
| `src/clock.js` | Server-time estimation by interval narrowing. |
| `src/http.js` | Keep-alive agent, pre-resolved IP, timeouts, hedging. |
| `src/api.js` | Endpoint calls and response classification. |
| `src/worker.js` | One wallet: schedule, retry policy, idempotency. |
| `src/runner.js` | Fleet orchestration, quiet period, throttle response. |
| `src/state.js` | Crash-safe `fsync`-ed state. |
| `src/config.js` · `config.json` | Every timing and budget constant, in one place. |
| `watchdog.sh` | Restarts the process if it dies. |

---

## Configuration

Put one address per line in `wallets.txt` (`#` starts a comment). They must be
real addresses in wallets you control — ownership is recorded against them.

The timing block is where the thinking lives:

| Key | Why it is that value |
| --- | --- |
| `leadMs: -300` | Fire 300 ms *before* the estimated start. Early is a cheap retry; late is nothing. |
| `quietBeforeMs: 60000` | Send nothing in the last minute so the token bucket refills. |
| `hedgeAfterMs: 4000` | Just above the measured p50 of 4.3 s. |
| `maxInFlight: 1` | Hedging off by default — a spare parallel copy costs a token and brings 429 closer. |
| `windowBudget: 1` / `windowMs: 45000` | Calibrated to the server's observed recovery, not to a rate we would like. |
| `throttleBackoffMs: 45000` | What the server actually needs to forgive a 429. |

---

## Running it

> Do **not** run `--recon` or `--rehearse` in the last ~10 minutes. Each run
> spends IP budget that has to be intact at T0.

```bash
node index.js --recon      # collection state, time to launch, per-wallet limits
node index.js --rehearse   # real request path; server must answer MINT_NOT_STARTED
node index.js              # live run — start it 5–10 minutes before launch
```

The rehearsal refuses to run if the mint has already started.

---

## What this is worth reading for

The interesting part is not the mint. It is what a client looks like when the
constraint is *request budget* instead of throughput, and when the server is
assumed hostile: measure first, spend nothing while waiting, make every retry
idempotent, and treat an unknown error as retryable rather than fatal.

## Scope

An unofficial client for a public HTTP API, written by reading its responses.
Using it is a terms-of-service question you own. No key, address or wallet of the
author is in this repository.

## Licence

No licence granted. Published for review as a portfolio piece.
