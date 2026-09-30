import fs from 'node:fs';
import path from 'node:path';

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
};
const LEVEL_COLOR = { debug: 'dim', info: 'reset', ok: 'green', warn: 'yellow', error: 'red', hit: 'magenta' };

let sink = null;
let debugEnabled = false;

export function initLog(stateDir, { debug = false } = {}) {
  debugEnabled = debug;
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
  sink = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level, msg, data) {
  if (level === 'debug' && !debugEnabled) return;
  const color = COLORS[LEVEL_COLOR[level] || 'reset'];
  const tail = data && Object.keys(data).length ? ` ${COLORS.dim}${JSON.stringify(data)}${COLORS.reset}` : '';
  process.stdout.write(`${COLORS.dim}${stamp()}${COLORS.reset} ${color}${msg}${COLORS.reset}${tail}\n`);
  if (sink) sink.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n');
}

export const log = {
  debug: (m, d) => emit('debug', m, d),
  info: (m, d) => emit('info', m, d),
  ok: (m, d) => emit('ok', m, d),
  warn: (m, d) => emit('warn', m, d),
  error: (m, d) => emit('error', m, d),
  hit: (m, d) => emit('hit', m, d)
};

export function closeLog() {
  return new Promise((resolve) => (sink ? sink.end(resolve) : resolve()));
}
