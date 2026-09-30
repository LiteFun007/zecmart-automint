#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseArgs } from './src/config.js';
import { initLog, log, closeLog } from './src/log.js';
import { bootstrap, run, summariseTarget, printSummary } from './src/runner.js';
import { api } from './src/api.js';
import { reconcile } from './src/worker.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(root, 'state');

async function recon(cfg) {
  const { client, clock, mintConfig, store } = await bootstrap(cfg, stateDir);
  summariseTarget(mintConfig);

  log.info('mint gate', {
    launchAt: mintConfig.launchAt,
    launchStarted: mintConfig.launchStarted,
    publicMintBlocked: mintConfig.publicMintBlocked,
    effectiveMintStatus: mintConfig.effectiveMintStatus
  });
  log.info('readiness', mintConfig.readiness || {});

  const launchAt = Date.parse(mintConfig.launchAt);
  if (Number.isFinite(launchAt)) {
    const left = launchAt - clock.now();
    log.info(`T-minus ${(left / 1000 / 60).toFixed(1)} minutes (server clock)`);
  }

  const st = await api.mintStatus(client);
  log.info('live status', st.json || {});

  for (const w of cfg.wallets) {
    const r = await api.walletLimits(client, w);
    log.info(`limits ${w.slice(0, 14)}…`, { status: r.status, ...(r.json || {}) });
  }
  if (!cfg.wallets.length) log.warn('no wallets configured yet (wallets.txt is empty)');

  client.destroy();
  void store;
}

async function reconcileOnly(cfg) {
  // Reconciling only needs the order endpoint; do not let a dead /api/mint/config
  // stop us from confirming orders we already own.
  const ctx = await bootstrap(cfg, stateDir, { needConfig: false, needClock: false });
  await reconcile({ ...ctx, cfg });
  printSummary(ctx.store);
  ctx.client.destroy();
}

async function main() {
  const { mode, flags } = parseArgs(process.argv.slice(2));
  const logFile = initLog(stateDir, { debug: !!flags.debug });

  const cfg = loadConfig(root);
  if (flags.quantity) cfg.quantity = flags.quantity;
  if (flags.leadMs !== undefined) cfg.timing.leadMs = flags.leadMs;

  log.info(`zecmart-automint | mode=${mode} | wallets=${cfg.wallets.length} | log=${path.basename(logFile)}`);

  const bail = (sig) => { log.warn(`${sig} received, flushing state`); closeLog().then(() => process.exit(130)); };
  process.on('SIGINT', () => bail('SIGINT'));
  process.on('SIGTERM', () => bail('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: String(e) }));
  // A dropped Wi-Fi link surfaces as an ENETUNREACH AggregateError from the
  // agent's socket layer, outside any request's error handler. Losing the
  // network must pause the run, never end it.
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception (continuing)', { code: e?.code, err: String(e?.message || e) });
  });

  if (mode === 'recon') await recon(cfg);
  else if (mode === 'reconcile') await reconcileOnly(cfg);
  else if (mode === 'rehearse') await run(cfg, stateDir, { rehearse: true });
  else await run(cfg, stateDir, { fireNow: !!flags.now });

  await closeLog();
}

main().catch(async (e) => {
  log.error(String(e?.stack || e));
  await closeLog();
  process.exit(1);
});
