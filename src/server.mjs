// ship-it - local control panel.
//
// This process spawns real shell commands and reads the machine's CLI
// sessions, so it binds to 127.0.0.1 and nothing else. It never receives,
// stores or proxies a credential: every login happens in a terminal the user
// owns, driven by the official CLI, and this server only watches for the
// resulting session to appear.

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, stat, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SHIP_IT_PORT || 4319);
const PLATFORM = process.platform;
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const WORKSPACE = join(homedir(), '.ship-it', 'clones');

// A tool installed after this process started lands on the persisted PATH,
// not the inherited one. On Windows that lives in the registry.
if (IS_WIN) {
  try {
    const { execFileSync } = await import('node:child_process');
    const persisted = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
      "[Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', timeout: 10000 }).trim();
    process.env.PATH = [process.env.PATH, persisted,
      join(process.env.APPDATA || '', 'npm'),
      join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
    ].filter(Boolean).join(';');
  } catch { /* keep the inherited PATH */ }
} else {
  // Homebrew and nvm are commonly absent from a GUI-launched process's PATH.
  process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin',
    join(homedir(), '.local', 'bin')].filter(Boolean).join(':');
}

// ---------------------------------------------------------------- spawning

const whichCache = new Map();

function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  const p = new Promise((res) => {
    execFile(IS_WIN ? 'where.exe' : 'which', [cmd], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) return res(null);
      const lines = stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!IS_WIN) return res(lines[0]);
      // npm ships three shims per tool on Windows and where.exe lists the
      // unusable one first: an extensionless sh script Windows cannot execute,
      // a .cmd, and a .ps1 that a Restricted execution policy refuses to load.
      const rank = (p2) => {
        const l = p2.toLowerCase();
        if (l.endsWith('.exe')) return 0;
        if (l.endsWith('.cmd')) return 1;
        if (l.endsWith('.bat')) return 2;
        if (l.endsWith('.ps1')) return 3;
        return 4;
      };
      const best = lines.slice().sort((a, b) => rank(a) - rank(b))[0];
      res(rank(best) === 4 ? null : best);
    });
  });
  whichCache.set(cmd, p);
  return p;
}

/** Spawn a tool with an argument ARRAY, never an interpolated command string. */
async function spawnTool(cmd, args, opts = {}) {
  const full = await which(cmd);
  if (!full) throw new Error(`${cmd} is not installed or not on PATH`);
  // Modern Node refuses to spawn .cmd/.bat directly; cmd.exe still receives
  // the arguments as a properly escaped array.
  if (IS_WIN && /\.(cmd|bat)$/i.test(full)) {
    return spawn('cmd.exe', ['/d', '/s', '/c', full, ...args], opts);
  }
  if (IS_WIN && /\.ps1$/i.test(full)) {
    return spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full, ...args], opts);
  }
  return spawn(full, args, opts);
}

async function run(cmd, args, opts = {}) {
  let child;
  try {
    child = await spawnTool(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { code: -1, out: '', err: e.message };
  }
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((res) => {
    child.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
    child.on('error', (e) => res({ code: -1, out: '', err: e.message }));
  });
}

// ------------------------------------------------------------ setup steps

// Every command here is a fixed literal. Nothing the user types is ever
// interpolated into a terminal command line.
const INSTALL = {
  git: {
    win32: 'winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements',
    darwin: 'brew install git',
    linux: 'sudo apt-get install -y git',
  },
  gh: {
    win32: 'winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements',
    darwin: 'brew install gh',
    linux: 'sudo apt-get install -y gh',
  },
  vercel: { win32: 'npm install -g vercel', darwin: 'npm install -g vercel', linux: 'npm install -g vercel' },
  claude: {
    win32: 'npm install -g @anthropic-ai/claude-code',
    darwin: 'npm install -g @anthropic-ai/claude-code',
    linux: 'npm install -g @anthropic-ai/claude-code',
  },
};

const LOGIN = {
  gh: 'gh auth login --web --hostname github.com --git-protocol https',
  vercel: 'vercel login',
  claude: 'claude',   // first run walks through sign-in, then exits on /exit
};

const STEP_IDS = ['git', 'gh', 'vercel', 'claude'];

async function stepStatus() {
  const steps = [];

  const git = await which('git');
  steps.push({
    id: 'git', label: 'Git', kind: 'tool',
    installed: Boolean(git), authed: Boolean(git),
    detail: git ? (await run('git', ['--version'])).out : 'not installed',
    action: git ? null : 'install',
  });

  const gh = await which('gh');
  let ghAuth = null;
  if (gh) {
    const r = await run('gh', ['api', 'user', '--jq', '.login']);
    if (r.code === 0 && r.out) ghAuth = r.out;
  }
  steps.push({
    id: 'gh', label: 'GitHub', kind: 'account',
    installed: Boolean(gh), authed: Boolean(ghAuth),
    detail: !gh ? 'CLI not installed' : ghAuth ? `signed in as ${ghAuth}` : 'not signed in',
    action: !gh ? 'install' : ghAuth ? null : 'login',
  });

  const vc = await which('vercel');
  let vcAuth = null;
  if (vc) {
    const args = process.env.VERCEL_TOKEN ? ['whoami', '--token', process.env.VERCEL_TOKEN] : ['whoami'];
    const r = await run('vercel', args);
    const line = r.out.split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !/^(>|Vercel CLI)/.test(s) && !/^</.test(s)).pop();
    if (r.code === 0 && line && !/logged out/i.test(line)) vcAuth = line;
  }
  steps.push({
    id: 'vercel', label: 'Vercel', kind: 'account',
    installed: Boolean(vc), authed: Boolean(vcAuth),
    detail: !vc ? 'CLI not installed' : vcAuth ? `signed in as ${vcAuth}` : 'not signed in',
    action: !vc ? 'install' : vcAuth ? null : 'login',
  });

  const cc = await which('claude');
  // There is no cheap "am I signed in" command, so this reads the config file
  // the CLI writes once it has an account. It is a hint, not proof: the first
  // run tells you for certain.
  const ccConfig = existsSync(join(homedir(), '.claude.json'));
  steps.push({
    id: 'claude', label: 'Claude Code', kind: 'account',
    installed: Boolean(cc), authed: Boolean(cc && ccConfig),
    detail: !cc ? 'CLI not installed' : ccConfig ? 'installed and configured' : 'installed, not signed in yet',
    action: !cc ? 'install' : ccConfig ? null : 'login',
  });

  return {
    platform: PLATFORM,
    steps,
    ready: steps.every((s) => s.installed && s.authed),
  };
}

/**
 * Open a real terminal window running one whitelisted setup command. The user
 * completes it themselves; no output, code or credential comes back here.
 */
async function launchSetup(idRaw, actionRaw) {
  const id = String(idRaw ?? '');
  const action = String(actionRaw ?? '');
  if (!STEP_IDS.includes(id)) throw new Error('Unknown step');
  if (action !== 'install' && action !== 'login') throw new Error('Unknown action');

  const command = action === 'install'
    ? INSTALL[id]?.[PLATFORM] ?? INSTALL[id]?.linux
    : LOGIN[id];
  if (!command) throw new Error(`No ${action} command for ${id} on ${PLATFORM}`);

  try {
    openTerminal(command);
    return { launched: true, command };
  } catch (e) {
    // Falling back to "run this yourself" is better than pretending it worked.
    return { launched: false, command, reason: e.message };
  }
}

function openTerminal(command) {
  if (IS_WIN) {
    const child = spawn('cmd.exe', ['/c', 'start', 'ship-it setup', 'cmd.exe', '/k', command],
      { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  if (IS_MAC) {
    const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const terminals = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', `${command}; exec bash`]],
    ['gnome-terminal', ['--', 'bash', '-lc', `${command}; exec bash`]],
    ['konsole', ['-e', 'bash', '-lc', `${command}; exec bash`]],
    ['xterm', ['-e', `bash -lc '${command.replace(/'/g, "'\\''")}; exec bash'`]],
  ];
  for (const [bin, args] of terminals) {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return;
    } catch { /* try the next one */ }
  }
  throw new Error('No terminal emulator found');
}

// --------------------------------------------------------- source resolving

const GIT_URL = /^(https?:\/\/|git@|ssh:\/\/)/i;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function sanitizeRepoName(raw) {
  return String(raw ?? '').trim()
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
}

function validateRepoName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('Repo name is required');
  if (!REPO_RE.test(name)) {
    throw new Error('Repo name may only contain letters, numbers, dot, dash and underscore');
  }
  return name;
}

/**
 * Accept the three things people actually paste: a folder path, a file:// URL,
 * and a git remote URL. A localhost URL is rejected on purpose, with an
 * explanation - a running server has no source tree to ship.
 */
async function resolveSource(raw, { clone = true } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Paste a project folder or a git URL');
  let input = raw.trim().replace(/^["']|["']$/g, '');

  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(input)) {
    throw new Error(
      'That is the address of a running dev server, not the code.\n'
      + 'Paste the project FOLDER instead (the one with package.json), or a git URL.');
  }

  if (input.startsWith('file://')) {
    try { input = fileURLToPath(input); } catch { throw new Error('Could not read that file:// URL'); }
  }

  if (GIT_URL.test(input)) {
    const name = sanitizeRepoName(basename(input.replace(/\/+$/, '')));
    if (!name) throw new Error('Could not work out a project name from that URL');
    const dest = join(WORKSPACE, name);
    if (!clone) return { path: dest, origin: input, cloned: true, name, pending: !existsSync(dest) };
    if (existsSync(dest) && (await readdir(dest)).length) {
      return { path: dest, origin: input, cloned: true, name, reused: true };
    }
    await mkdir(WORKSPACE, { recursive: true });
    const r = await run('git', ['clone', '--depth', '1', input, dest]);
    if (r.code !== 0) throw new Error(`git clone failed: ${(r.err || r.out).split('\n').pop()}`);
    return { path: dest, origin: input, cloned: true, name };
  }

  const path = resolvePath(input);
  let st;
  try { st = await stat(path); } catch { throw new Error(`Folder does not exist: ${path}`); }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${path}`);
  return { path, origin: null, cloned: false, name: sanitizeRepoName(basename(path)) };
}

// ------------------------------------------------------------- inspection

async function inspectProject(source) {
  const path = source.path;
  const has = async (f) => { try { await stat(join(path, f)); return true; } catch { return false; } };

  let pkg = null;
  try { pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); } catch { /* not node */ }
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  let pm = 'npm';
  if (await has('pnpm-lock.yaml')) pm = 'pnpm';
  else if (await has('yarn.lock')) pm = 'yarn';
  else if (await has('bun.lockb') || await has('bun.lock')) pm = 'bun';

  let framework = 'static / unknown';
  let deployable = true;
  if (deps.next) framework = 'Next.js';
  else if (deps.nuxt) framework = 'Nuxt';
  else if (deps['@sveltejs/kit']) framework = 'SvelteKit';
  else if (deps.astro) framework = 'Astro';
  else if (deps['react-scripts']) framework = 'Create React App';
  else if (await has('vite.config.js') || await has('vite.config.ts')) framework = 'Vite';
  else if (deps.express || deps.fastify) { framework = 'Node server'; deployable = false; }
  else if (await has('index.html')) framework = 'Static site';

  const branch = await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const origin = await run('git', ['-C', path, 'remote', 'get-url', 'origin']);
  const tracked = await run('git', ['-C', path, 'ls-files']);
  const leaked = tracked.code === 0
    ? tracked.out.split(/\r?\n/).filter((f) =>
        /(^|\/)\.env($|\.)/.test(f) && !/\.(example|sample|template)$/.test(f))
    : [];

  return {
    path,
    clonedFrom: source.origin,
    suggestedName: sanitizeRepoName(pkg?.name || source.name),
    framework, pm, deployable,
    scripts: Object.keys(pkg?.scripts || {}),
    hasPackageJson: Boolean(pkg),
    isRepo: branch.code === 0,
    branch: branch.code === 0 ? branch.out : null,
    origin: origin.code === 0 ? origin.out : null,
    leaked,
    linkedToVercel: existsSync(join(path, '.vercel', 'project.json')),
  };
}

async function repoStatus(name) {
  if (!(await which('gh'))) return { known: false, reason: 'GitHub CLI not installed' };
  const me = await run('gh', ['api', 'user', '--jq', '.login']);
  if (me.code !== 0) return { known: false, reason: 'not signed in to GitHub' };
  const full = name.includes('/') ? name : `${me.out}/${name}`;
  const r = await run('gh', ['repo', 'view', full, '--json', 'name,url,visibility']);
  if (r.code !== 0) return { known: true, exists: false, full, owner: me.out };
  try { return { known: true, exists: true, full, owner: me.out, ...JSON.parse(r.out) }; }
  catch { return { known: true, exists: false, full, owner: me.out }; }
}

// -------------------------------------------------------------- agent run

const runs = new Map();

function buildPrompt({ path, repo, visibility, existing, clonedFrom }) {
  return [
    'Use the ship-it subagent to ship this project end to end.',
    '',
    `path: ${path}`,
    `repo name: ${repo}`,
    `visibility: ${visibility}`,
    existing
      ? `target: the existing GitHub repo ${existing}. Push into it. Do NOT create a new `
        + 'repo, do NOT force-push, and do NOT rewrite its history.'
      : `target: a new GitHub repo named "${repo}" that does not exist yet. Create it.`,
    clonedFrom ? `note: this working copy was cloned from ${clonedFrom}.` : '',
    '',
    'Follow the ship-it agent definition exactly, including the phase order and the hard',
    'gates. If a gate blocks, stop and return the BLOCKED report instead of working',
    'around it. Finish with the agent\'s final report format.',
  ].filter(Boolean).join('\n');
}

function push(state, event) {
  state.events.push(event);
  for (const send of state.listeners) send(event);
}

async function startRun(cfg) {
  const id = randomUUID();
  const state = { id, events: [], done: false, listeners: new Set(), child: null };
  runs.set(id, state);

  push(state, { type: 'meta', text: `project  ${cfg.path}` });
  push(state, { type: 'meta', text: `repo     ${cfg.repo} (${cfg.existing ? 'existing' : 'new'}, ${cfg.visibility})` });
  push(state, { type: 'meta', text: '' });

  const prompt = buildPrompt(cfg);

  if (!(await which('claude'))) {
    push(state, { type: 'error', text: 'Claude Code is not installed. Finish setup first.' });
    push(state, { type: 'prompt', text: prompt });
    state.done = true;
    push(state, { type: 'done', code: -1 });
    return id;
  }

  // A headless run cannot answer a permission prompt, so its permissions are
  // decided up front. Grant exactly the tools this pipeline uses rather than
  // disabling the permission system: anything else still stops the run.
  const ALLOWED = [
    'Bash(git:*)', 'Bash(gh:*)', 'Bash(vercel:*)', 'Bash(node:*)',
    'Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(bun:*)',
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch',
  ].join(',');

  let child;
  try {
    child = await spawnTool('claude', [
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED,
    ], { cwd: cfg.path, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  } catch (e) {
    push(state, { type: 'error', text: e.message });
    state.done = true;
    push(state, { type: 'done', code: -1 });
    return id;
  }

  state.child = child;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) translate(state, line);
    }
  });
  child.stderr.on('data', (d) => push(state, { type: 'stderr', text: d.toString() }));
  child.on('close', (code) => { state.done = true; push(state, { type: 'done', code }); });
  child.on('error', (e) => {
    push(state, { type: 'error', text: e.message });
    state.done = true;
    push(state, { type: 'done', code: -1 });
  });
  return id;
}

function translate(state, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return push(state, { type: 'raw', text: line }); }
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        push(state, { type: 'text', text: block.text.trim() });
      } else if (block.type === 'tool_use') {
        const i = block.input || {};
        const detail = i.command || i.file_path || i.pattern || i.path || '';
        push(state, { type: 'tool', text: `${block.name}  ${String(detail).slice(0, 200)}` });
      }
    }
  } else if (msg.type === 'result') {
    push(state, { type: 'result', text: msg.result || '', error: Boolean(msg.is_error) });
  }
}

// ----------------------------------------------------------------- server

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw new Error('Request body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // A page on another origin can submit a simple form but cannot set a custom
  // header, so requiring one keeps a hostile page away from these endpoints.
  if (req.method === 'POST' && req.headers['x-ship-it'] !== '1') {
    return json(res, 403, { error: 'Missing X-Ship-It header' });
  }

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(join(HERE, 'ui.html')));
    }
    if (url.pathname === '/api/status') return json(res, 200, await stepStatus());

    if (url.pathname === '/api/setup' && req.method === 'POST') {
      const b = await readJson(req);
      return json(res, 200, await launchSetup(b.id, b.action));
    }
    if (url.pathname === '/api/inspect' && req.method === 'POST') {
      const b = await readJson(req);
      const source = await resolveSource(b.path);
      return json(res, 200, await inspectProject(source));
    }
    if (url.pathname === '/api/repo' && req.method === 'POST') {
      const b = await readJson(req);
      return json(res, 200, await repoStatus(validateRepoName(b.name)));
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const b = await readJson(req);
      const source = await resolveSource(b.path);
      const repo = validateRepoName(b.repo);
      const status = await repoStatus(repo);
      const id = await startRun({
        path: source.path,
        clonedFrom: source.origin,
        repo,
        visibility: b.visibility === 'public' ? 'public' : 'private',
        existing: status.exists ? status.url : null,
      });
      return json(res, 200, { id });
    }
    if (url.pathname === '/api/stream') {
      const state = runs.get(url.searchParams.get('id'));
      if (!state) return json(res, 404, { error: 'No such run' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of state.events) send(e);      // replay makes reload safe
      if (state.done) return res.end();
      state.listeners.add(send);
      req.on('close', () => state.listeners.delete(send));
      return;
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const b = await readJson(req);
      const state = runs.get(b.id);
      if (state?.child && !state.done) state.child.kill();
      return json(res, 200, { stopped: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ship-it  ->  http://127.0.0.1:${PORT}`);
  console.log('  Local only. This process runs shell commands; do not expose it.\n');
});

export { resolveSource, sanitizeRepoName, validateRepoName, which };
