import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(root, overrides = {}) {
  const cfgPath = path.join(root, 'config.json');
  if (!fs.existsSync(cfgPath)) throw new Error(`config.json not found at ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  let wallets = Array.isArray(cfg.wallets) ? [...cfg.wallets] : [];
  if (cfg.walletsFile) {
    const wf = path.join(root, cfg.walletsFile);
    if (fs.existsSync(wf)) {
      wallets.push(...fs.readFileSync(wf, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')));
    }
  }

  // De-dupe: two workers on the same address just race each other for one slot.
  const seen = new Set();
  cfg.wallets = wallets.filter((w) => {
    const k = w.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  Object.assign(cfg, overrides);
  if (!cfg.baseUrl) throw new Error('config.baseUrl is required');
  if (!Number.isInteger(cfg.quantity) || cfg.quantity < 1) throw new Error('config.quantity must be a positive integer');
  return cfg;
}

export function parseArgs(argv) {
  const out = { mode: 'run', flags: {} };
  for (const a of argv) {
    if (a === '--recon') out.mode = 'recon';
    else if (a === '--rehearse') out.mode = 'rehearse';
    else if (a === '--reconcile') out.mode = 'reconcile';
    else if (a === '--now') out.flags.now = true;
    else if (a === '--debug') out.flags.debug = true;
    else if (a.startsWith('--lead=')) out.flags.leadMs = Number(a.split('=')[1]);
    else if (a.startsWith('--qty=')) out.flags.quantity = Number(a.split('=')[1]);
  }
  return out;
}
