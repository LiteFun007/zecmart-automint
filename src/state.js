import fs from 'node:fs';
import path from 'node:path';

// Crash-durable record of every order we know about. Written synchronously and
// fsync'd, because the whole point is to survive the process dying mid-mint.
export class Store {
  constructor(stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, 'orders.json');
    this.orders = new Map();
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const o of raw.orders || []) this.orders.set(o.key, o);
      } catch { /* corrupt file: start clean, the old one stays on disk as .bak */
        try { fs.copyFileSync(this.file, this.file + '.bak'); } catch {}
      }
    }
  }

  // key = wallet + attempt group, so a retry of the same logical attempt updates
  // the same record instead of appending a duplicate.
  upsert(key, patch) {
    const prev = this.orders.get(key) || { key, createdAt: new Date().toISOString() };
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    this.orders.set(key, next);
    this.flush();
    return next;
  }

  get(key) { return this.orders.get(key); }
  all() { return [...this.orders.values()]; }

  flush() {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify({ orders: this.all() }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}
