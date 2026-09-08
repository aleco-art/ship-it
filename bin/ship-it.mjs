#!/usr/bin/env node
// ship-it launcher: installs the agent definition where Claude Code looks for
// it, starts the local control panel, and opens a browser at it.

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHIP_IT_PORT || 4319);
const AGENTS = join(homedir(), '.claude', 'agents');

// The panel is only a front end; the agent definition is the actual product,
// and Claude Code loads it from ~/.claude/agents. Copy it on every launch so
// an upgrade of this package also upgrades the agent, but never clobber a
// version the user has edited themselves.
async function installAgent() {
  const src = join(ROOT, 'agent', 'ship-it.md');
  const dest = join(AGENTS, 'ship-it.md');
  await mkdir(AGENTS, { recursive: true });

  // Phase 0 of the agent shells out to the preflight, so it has to sit at the
  // fixed path the agent definition names.
  const support = join(homedir(), '.claude', 'ship-it');
  await mkdir(support, { recursive: true });
  await copyFile(join(ROOT, 'agent', 'preflight.mjs'), join(support, 'preflight.mjs'));

  if (existsSync(dest)) {
    const [a, b] = await Promise.all([readFile(src, 'utf8'), readFile(dest, 'utf8')]);
    if (a === b) return 'already installed';
    return 'kept your edited copy at ' + dest;
  }
  await copyFile(src, dest);
  return 'installed to ' + dest;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the URL is printed below either way */ }
}

const note = await installAgent();
console.log(`\n  ship-it agent: ${note}`);

const server = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SHIP_IT_PORT: String(PORT) },
});

setTimeout(() => openBrowser(`http://127.0.0.1:${PORT}`), 900);

const bye = () => { server.kill(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
server.on('close', (code) => process.exit(code ?? 0));
