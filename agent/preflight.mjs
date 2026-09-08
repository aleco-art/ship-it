#!/usr/bin/env node
// ship-it preflight - one call, full go/no-go report.
//   node preflight.mjs [project path]
// Exit 0 = every hard gate passed. Exit 1 = at least one blocker.
// Standalone on purpose: the agent runs this before anything else exists.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const TARGET = resolve(process.argv[2] || process.cwd());
const IS_WIN = process.platform === 'win32';

if (IS_WIN) {
  try {
    const persisted = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
      "[Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', timeout: 10000 }).trim();
    process.env.PATH = [process.env.PATH, persisted,
      join(process.env.APPDATA || '', 'npm')].filter(Boolean).join(';');
  } catch { /* keep inherited PATH */ }
} else {
  process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].join(':');
}

const blockers = [];
const pad = (s) => s.padEnd(32);
const ok = (n, d) => console.log('  [ OK ]  ' + pad(n) + (d || ''));
const warn = (n, d) => console.log('  [WARN]  ' + pad(n) + (d || ''));
const bad = (n, d, fix) => { blockers.push(n + ' -> ' + fix); console.log('  [BLOCK] ' + pad(n) + (d || '')); };

function which(cmd) {
  try {
    const out = execFileSync(IS_WIN ? 'where.exe' : 'which', [cmd],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    if (!IS_WIN) return lines[0];
    // npm's Windows shims: the extensionless one cannot be executed and the
    // .ps1 is blocked by a Restricted execution policy. Rank them.
    const rank = (p) => {
      const l = p.toLowerCase();
      if (l.endsWith('.exe')) return 0;
      if (l.endsWith('.cmd')) return 1;
      if (l.endsWith('.bat')) return 2;
      if (l.endsWith('.ps1')) return 3;
      return 4;
    };
    const best = lines.slice().sort((a, b) => rank(a) - rank(b))[0];
    return rank(best) === 4 ? null : best;
  } catch { return null; }
}

function sh(cmd, args, opts = {}) {
  return new Promise((res) => {
    const full = which(cmd);
    if (!full) return res({ code: -1, out: '', err: 'not found' });
    const useCmd = IS_WIN && /\.(cmd|bat)$/i.test(full);
    const file = useCmd ? 'cmd.exe' : full;
    const argv = useCmd ? ['/d', '/s', '/c', full, ...args] : args;
    execFile(file, argv, { timeout: 30000, ...opts }, (err, stdout, stderr) =>
      res({ code: err ? (err.code ?? 1) : 0, out: (stdout || '').trim(), err: (stderr || '').trim() }));
  });
}

console.log('=== ship-it preflight ===');
console.log('target: ' + TARGET + '\n');

console.log('-- toolchain --');
for (const t of ['git', 'node', 'gh', 'vercel', 'claude']) {
  const found = which(t);
  if (found) {
    const v = await sh(t, ['--version']);
    ok(t, (v.out || '').split(/\r?\n/).pop());
  } else {
    const fix = {
      gh: IS_WIN ? 'winget install --id GitHub.cli -e' : 'brew install gh',
      vercel: 'npm i -g vercel',
      claude: 'npm i -g @anthropic-ai/claude-code',
    }[t] || ('install ' + t);
    bad(t, 'not on PATH', fix);
  }
}

let pm = 'npm';
for (const [file, name] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'], ['bun.lock', 'bun']]) {
  if (existsSync(join(TARGET, file))) { pm = name; break; }
}
ok('package manager', pm + ' (from lockfile)');

console.log('\n-- github auth --');
if (which('gh')) {
  const me = await sh('gh', ['api', 'user', '--jq', '.login']);
  if (me.code === 0 && me.out) {
    ok('gh account', me.out + (process.env.GH_TOKEN ? ' (env token)' : ' (keyring)'));
  } else bad('gh account', 'not authenticated', 'gh auth login  (or set GH_TOKEN)');
} else warn('gh account', 'skipped, gh missing');

console.log('\n-- vercel auth --');
if (which('vercel')) {
  const args = process.env.VERCEL_TOKEN ? ['whoami', '--token', process.env.VERCEL_TOKEN] : ['whoami'];
  const r = await sh('vercel', args);
  const line = r.out.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !/^(>|Vercel CLI|<)/.test(s)).pop();
  if (r.code === 0 && line && !/logged out/i.test(line)) ok('vercel account', line);
  else bad('vercel account', 'not authenticated', 'vercel login  (or set VERCEL_TOKEN)');
} else warn('vercel account', 'skipped, vercel missing');

console.log('\n-- repo state (determines which phases to skip) --');
const inRepo = await sh('git', ['-C', TARGET, 'rev-parse', '--is-inside-work-tree']);
if (inRepo.out === 'true') {
  const branch = await sh('git', ['-C', TARGET, 'rev-parse', '--abbrev-ref', 'HEAD']);
  ok('git repo', "yes, on branch '" + branch.out + "'");
  const origin = await sh('git', ['-C', TARGET, 'remote', 'get-url', 'origin']);
  if (origin.code === 0 && origin.out) ok('origin', origin.out);
  else warn('origin', 'none - the repo phase will create it');

  const dirty = await sh('git', ['-C', TARGET, 'status', '--porcelain']);
  const n = dirty.out ? dirty.out.split(/\r?\n/).length : 0;
  if (n) warn('working tree', n + ' uncommitted path(s)');
  else ok('working tree', 'clean');

  // Anything already committed cannot be un-leaked by editing .gitignore.
  const tracked = await sh('git', ['-C', TARGET, 'ls-files']);
  const leaked = tracked.out.split(/\r?\n/).filter((f) =>
    /(^|\/)\.env($|\.)/.test(f) && !/\.(example|sample|template)$/.test(f));
  if (leaked.length) bad('tracked .env', leaked.join(', '), 'STOP. rotate those secrets, then purge from history');
  else ok('tracked .env', 'none');
} else {
  warn('git repo', 'not a repo - the repo phase will run git init');
}

const vjson = join(TARGET, '.vercel', 'project.json');
if (existsSync(vjson)) {
  try { ok('vercel link', 'already linked: ' + JSON.parse(readFileSync(vjson, 'utf8')).projectId); }
  catch { ok('vercel link', 'already linked'); }
} else warn('vercel link', 'not linked - the deploy phase will link it');

if (existsSync(join(TARGET, 'package.json'))) ok('package.json', 'present');
else warn('package.json', 'absent - static or non-node project');

console.log('');
if (!blockers.length) {
  console.log('RESULT: GO - all hard gates passed.');
  process.exit(0);
}
console.log('RESULT: NO-GO - ' + blockers.length + ' blocker(s). Do not create repos or deploy.');
for (const b of blockers) console.log('  * ' + b);
process.exit(1);
