# ship-it

**[ship-it-agent.vercel.app](https://ship-it-agent.vercel.app)** — the interface, in preview.

Paste a folder you run on localhost. Get a documented GitHub repo and a live Vercel URL.

```bash
npx github:aleco-art/ship-it
```

That opens a local control panel at `http://127.0.0.1:4319`. Point it at a project,
give it a repo name, press **Run agent**.

---

## What it actually does

Eight phases. The four gates stop the run rather than leave you half-shipped.

| # | Phase | |
| --- | --- | --- |
| 01 | **Preflight** | tools, both sign-ins, repo state — before touching anything | gate |
| 02 | Recon | framework, package manager, scripts, existing docs | |
| 03 | **Secret scan** | fixes `.gitignore`, refuses to commit a live credential | gate |
| 04 | **Local build** | runs your real production build before anything remote exists | gate |
| 05 | Env vars | finds every variable your code reads, writes `.env.example`, pushes to Vercel | |
| 06 | Docs | README from verified facts only | |
| 07 | GitHub + Vercel | creates or reuses the repo, connects git, deploys | |
| 08 | **Verify** | fetches the live URL, confirms a push auto-deploys | gate |

### Why that order

Sorted by what a mistake costs to find:

| Failure found… | Costs |
| --- | --- |
| in recon | seconds |
| in the local production build | ~1 minute |
| in the Vercel build | a push, 2–5 min, a log dig |
| after the production deploy | a broken public URL |
| after a secret is pushed | rotating every key |

So: secrets before git, build before deploy, docs before the first commit — and never
create anything remote to find out whether the local state was valid.

## What you need

Git, the GitHub CLI, the Vercel CLI, and Claude Code. The panel detects what is missing
and gives each one a button that opens a terminal and runs the install or login command.

**No token, password or one-time code passes through this app.** Sign-in happens in the
official CLI, in your own terminal. The session lands in your OS credential store, and
the agent reads it the same way you would from a shell.

## What you can paste

- a folder path — `/home/you/my-app` or `C:\Users\you\my-app`
- a `file://` URL
- a git URL — `https://github.com/you/my-app.git`, cloned to `~/.ship-it/clones`

A `http://localhost:3000` address is rejected on purpose: that is a running server, not
source code, so there is nothing to ship from it.

## Using the agent without the panel

The panel is a front end. The agent is `agent/ship-it.md`, installed to
`~/.claude/agents/ship-it.md` on first launch. From any Claude Code session:

```
use the ship-it agent to ship this project
```

The preflight runs standalone too:

```bash
node ~/.claude/ship-it/preflight.mjs /path/to/project
```

Exit 0 means every hard gate passed.

## Limits worth knowing

- **It saves the most time once per project.** After the first ship, `git push` already
  deploys. This automates the setup you do once and never remember.
- **Vercel-shaped projects only.** Static, Next.js, Vite, Astro, SvelteKit, Nuxt, Remix.
  A long-running server, websocket, or background worker does not run on serverless
  functions — the agent stops and says so.
- **Read the README it writes.** Built from verified facts, still worth your eyes.
- **A run costs tokens** on your Claude account.
- **Private by default.** Public only when you pick public.

## Security notes

- The server binds `127.0.0.1` only and requires an `X-Ship-It` header on every POST, so
  a page on another origin cannot drive it.
- Every command is spawned with an argument array; nothing you type is interpreted as
  shell syntax. Repo names are validated, and setup commands come from a fixed whitelist.
- The headless run is granted a fixed `--allowedTools` list — `git`, `gh`, `vercel`, your
  package manager, file edits — instead of disabling the permission system. Anything
  outside that list stops the run.

## License

MIT
