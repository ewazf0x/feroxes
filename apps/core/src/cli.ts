#!/usr/bin/env node
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { explainRun } from '@feroxes/brain';
import { createJsonLogger, errorMessage, formatUsd } from '@feroxes/shared';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';
import { runDemo } from './demo.ts';
import { startServer } from './server.ts';
import { Vault } from './vault.ts';

const HELP = `feroxes <command>

  demo      End-to-end demo with scripted providers and a simulated PC (no API keys needed)
  chat      Chat with your real providers; data is saved in FEROXES_DATA_DIR/feroxes.db
  serve     Run the Core as a local service (the PC/mobile apps connect to it); 24/7 brain
  live      Verify with your real credentials: live [providers|voice|connectors|all] [--quick]
  keygen    Print a new FEROXES_MASTER_KEY
  help      Show this help

Keys come from the environment (see .env.example): ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
OPENROUTER_API_KEY, OLLAMA_BASE_URL, ELEVENLABS_API_KEY. Run: node --env-file=.env apps/core/src/cli.ts chat`;

const COMMANDS = `/usage /budget /memories /goals /goal <title> /accept <goal id> /self /why /briefing /reflect /growth /devices /pair /mode <normal|economy|background_paused> /stop /resume /quit`;

async function chat() {
  const fx = await createFeroxes(loadEnv());
  const stopScheduler = fx.brain.scheduler.start();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const session = await fx.runtime.createSession('cli');
  const self = fx.brain.self.get();
  process.stdout.write(`${self.identity.name} (self-model v${self.version}, start #${self.identity.bootCount}) — providers: ${fx.catalog.listProviders().map((p) => p.name).join(', ')}${fx.voice ? ', ElevenLabs voice' : ''}.\nCommands: ${COMMANDS}\n`);
  fx.events.subscribe('run.delta', (e) => e.payload.sessionId === session.id && process.stdout.write(e.payload.text));
  fx.events.subscribe('run.reset', (e) => e.payload.sessionId === session.id && process.stdout.write('\n[provider failed mid-answer; retrying with another]\n'));
  const out = (s: string) => process.stdout.write(`${s}\n`);

  while (true) {
    const line = (await rl.question('\nyou › ')).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ').trim();
    if (cmd === '/quit') break;
    switch (cmd) {
      case '/stop':
        await fx.system.stop('owner', 'cli');
        out('Stopped. Everything is blocked, including paired devices, until /resume.');
        continue;
      case '/resume':
        await fx.system.resume('owner', 'cli');
        out('Resumed.');
        continue;
      case '/usage':
        for (const row of await fx.ledger.summarize({}, 'modelId')) out(`${row.key.padEnd(44)} ${row.calls} calls, ${row.errors} errors, ${formatUsd(row.cost)}`);
        continue;
      case '/budget':
        for (const b of await fx.budget.status()) out(`${b.budget.name.padEnd(20)} ${formatUsd(b.counter.spent)} of ${formatUsd(b.budget.limit)} (${b.percent.toFixed(1)}%), resets ${new Date(b.resetsAt).toISOString()}`);
        out(`Power mode: ${fx.power.mode}`);
        continue;
      case '/mode':
        fx.power.set(arg as 'normal' | 'economy' | 'background_paused', 'owner', 'cli');
        out(`Power mode: ${fx.power.mode}`);
        continue;
      case '/memories':
        await fx.flushMemory(session.id);
        for (const m of await fx.memory.store.list({ statuses: ['active'] })) out(`[m:${m.id.slice(-8)}] ${m.kind}${m.pinned ? ' (forever)' : ''}: ${m.content}`);
        continue;
      case '/goals':
        out(fx.brain.goals.render(30) || 'No goals yet. Add one with /goal <title>.');
        continue;
      case '/goal':
        if (arg) out(`Added goal [g:${fx.brain.goals.create({ title: arg, horizon: 'week' }, 'owner').id.slice(-6)}]. Feroxes will suggest next steps.`);
        continue;
      case '/accept': {
        const g = fx.brain.goals.get(arg);
        if (g) out(`Accepted: ${fx.brain.goals.setStatus(g.id, 'active', 'owner').title}`);
        else out('No such goal.');
        continue;
      }
      case '/self':
        out(fx.brain.self.render());
        for (const p of fx.brain.self.proposals()) out(`Proposal waiting for you: ${p.reason} ${JSON.stringify(p.patch)}`);
        continue;
      case '/why': {
        const runs = await fx.agentStore.listRuns({ sessionId: session.id });
        out(runs.length ? await explainRun({ store: fx.agentStore, audit: fx.audit, memory: fx.memory.store }, runs.at(-1)!.id) : 'Nothing to explain yet.');
        continue;
      }
      case '/briefing':
        out(await fx.brain.briefing('morning'));
        continue;
      case '/reflect': {
        const log = await fx.brain.reflection.reflect();
        out(log ? log.summary : 'Nothing to reflect on yet today.');
        continue;
      }
      case '/growth':
        out(fx.brain.reflection.evolutionReport(7));
        continue;
      case '/devices':
        out(fx.hub.devices().map((d) => `${d.name} (${d.platform}) ${d.online ? 'online' : 'offline'}`).join('\n') || 'No devices paired yet.');
        continue;
      case '/pair': {
        const { code, expiresAt } = fx.hub.createPairingCode();
        out(`Pairing code: ${code} (valid until ${new Date(expiresAt).toLocaleTimeString()}). Enter it in the Feroxes app on the device.`);
        continue;
      }
    }

    process.stdout.write('feroxes › ');
    let run = await (await fx.runtime.sendMessage(session.id, line)).done;
    while (run.status === 'waiting_approval' && run.waitingApprovalId) {
      const approval = await fx.approvals.get(run.waitingApprovalId);
      out(`\n\nApproval needed: ${approval?.preview.title}\n${approval?.preview.body ?? ''}\nReason: ${approval?.policyReason}`);
      const canGrant = approval?.category === 'device_control';
      const answer = (await rl.question(`Approve? [y]es / [N]o${canGrant ? ' / [a]llow for this task' : ''} `)).trim().toLowerCase();
      process.stdout.write('feroxes › ');
      const yes = answer === 'y' || answer === 'yes' || (canGrant && answer === 'a');
      const resumed = await fx.runtime.resolveApproval(run.waitingApprovalId, { approve: yes, ...(canGrant && answer === 'a' ? { scope: 'task' as const } : {}) });
      if (!resumed) break;
      run = await resumed.done;
    }
    out(`\n[${run.modelId ?? '-'} · ${run.totals.steps} step(s) · ${formatUsd(run.totals.costNanoUsd)}${run.status !== 'completed' ? ` · ${run.status}` : ''}]`);
    for (const n of fx.notifications.splice(0)) out(`🔔 ${n.title}: ${n.body}`);
  }
  stopScheduler();
  await fx.flushMemory(session.id);
  await fx.shutdown();
  rl.close();
}

/**
 * Per-user config directory for Feroxes, chosen to match what the desktop app computes on each OS
 * (Rust `dirs::config_dir()/feroxes`): %APPDATA%\feroxes on Windows, ~/Library/Application
 * Support/feroxes on macOS, $XDG_CONFIG_HOME|~/.config/feroxes on Linux. The runtime handshake
 * lives here so the app and a background Core find each other regardless of working directory.
 */
function feroxesConfigDir(): string {
  const home = homedir();
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'feroxes');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'feroxes');
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'feroxes');
}

/**
 * Runs the PC device agent for the computer the Core is on, as a child tied to the Core's life (its
 * stdin is the lifeline). On first start it pairs itself with a fresh one-time code passed in the
 * environment (never on the command line); afterwards it reconnects with its saved token. Device
 * actions still go through the policy gate and approvals like any other device.
 */
function startLocalAgent(fx: Awaited<ReturnType<typeof createFeroxes>>, port: number): { stop(): void } {
  const entry = [resolve(import.meta.dirname, '../pc-agent/src/cli.js'), resolve(import.meta.dirname, '../../pc-agent/src/cli.ts')].find((p) => existsSync(p));
  if (!entry) {
    process.stderr.write('FEROXES_LOCAL_AGENT is on, but the PC agent is not installed next to the Core.\n');
    return { stop() {} };
  }
  let child: ChildProcess | undefined;
  let stopping = false;
  let restarts = 0;
  const launch = () => {
    child = spawn(process.execPath, ['--no-warnings', entry, 'run', '--core', `ws://127.0.0.1:${port}/devices`], {
      env: { ...process.env, FEROXES_PAIR_CODE: fx.hub.createPairingCode().code, FEROXES_PARENT_PIPE: '1' },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d.toString('utf8').replace(/^(?=.)/gm, '[pc-agent] ')));
    child.on('exit', (code) => {
      if (stopping || code === 2) return; // 2 = refused (e.g. the Core's key changed): don't loop
      if (++restarts <= 5) setTimeout(launch, 5000 * restarts).unref();
    });
  };
  launch();
  return {
    stop() {
      stopping = true;
      child?.stdin?.end();
    },
  };
}

/**
 * Run the Core as a long-lived local service on 127.0.0.1. The desktop and mobile apps connect to
 * it over the local API. Prints a `FEROXES_READY {json}` line on stdout that the desktop host reads
 * to learn the URL and app token; also writes FEROXES_DATA_DIR/runtime.json so an app can attach to
 * an already-running Core (the 24/7 background brain) instead of starting a second one.
 */
async function serve() {
  // Default the data dir to the shared per-user config dir, so a background Core and an
  // app-spawned Core use the same brain (one SQLite file) unless the owner sets FEROXES_DATA_DIR.
  if (!process.env.FEROXES_DATA_DIR) process.env.FEROXES_DATA_DIR = feroxesConfigDir();
  const env = loadEnv();
  const dataDir = resolve(env.FEROXES_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });

  // Stable app token, persisted (0600) so a restarted Core keeps the same token and paired apps
  // reattach without re-pairing.
  const tokenFile = join(dataDir, 'app-token');
  let token: string;
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('empty token file');
  } catch {
    token = randomBytes(24).toString('base64url');
    await writeFile(tokenFile, token, { mode: 0o600 });
  }

  // A closed stdout/stderr pipe (for example, the app that started us quit) must never crash the brain.
  for (const s of [process.stdout, process.stderr]) s.on('error', () => {});

  // Keep stdout clean for the handshake line; send logs to stderr.
  const logger = createJsonLogger({ level: 'warn', write: (l) => process.stderr.write(`${l}\n`) });
  const fx = await createFeroxes(env, { logger });

  // Serve the UI from the Core as well. The desktop window loads it from here, so the page and the
  // API share one origin (http://127.0.0.1:<port>): no CORS, and no Local Network Access block or
  // prompt in WebView2/WebKit. It also opens in any browser at the Core URL. Looked up in the
  // bundled app layout (core/www) and in the repo layout (apps/desktop/ui/www, `pnpm run ui`).
  const staticDir = [process.env.FEROXES_UI_DIR, resolve(import.meta.dirname, '../www'), resolve(import.meta.dirname, '../../desktop/ui/www')].find(
    (d): d is string => !!d && existsSync(join(d, 'index.html')),
  );

  const deviceHosts = env.FEROXES_DEVICE_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
  let srv: Awaited<ReturnType<typeof startServer>>;
  try {
    srv = await startServer(fx, { port: env.FEROXES_PORT, token, ...(staticDir ? { staticDir } : {}), ...(deviceHosts.length ? { deviceHosts } : {}) });
  } catch (error) {
    const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
    process.stderr.write(inUse ? `Port ${env.FEROXES_PORT} is already in use; another Feroxes Core may be running. Stop it, or set FEROXES_PORT.\n` : `Could not start the local API: ${errorMessage(error)}\n`);
    await fx.shutdown();
    process.exit(1);
  }
  const stopScheduler = fx.brain.scheduler.start();
  const localAgent = env.FEROXES_LOCAL_AGENT ? startLocalAgent(fx, srv.port) : undefined;

  // Write the handshake where apps look for it. The config-dir copy is the rendezvous the desktop
  // app reads to attach to an already-running Core (so it never starts a second one on the same
  // database); the data-dir copy is for humans. Both are removed on a clean exit.
  const payload = `${JSON.stringify({ url: srv.url, token, pid: process.pid, port: srv.port, startedAt: Date.now() }, null, 2)}\n`;
  const runtimeFiles = [...new Set([join(dataDir, 'runtime.json'), join(feroxesConfigDir(), 'runtime.json')])];
  for (const file of runtimeFiles) {
    mkdirSync(resolve(file, '..'), { recursive: true });
    await writeFile(file, payload, { mode: 0o600 });
  }

  process.stdout.write(`FEROXES_READY ${JSON.stringify({ url: srv.url, token })}\n`);
  process.stderr.write(`Feroxes Core listening on ${srv.url}${staticDir ? ' — open it in a browser or the desktop app' : ''}. Ctrl+C to stop.\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 3000).unref(); // never hang on a stuck connection
    await Promise.all(runtimeFiles.map((f) => rm(f, { force: true }).catch(() => {}))); // drop handshakes first, so no app attaches to a dying Core
    try {
      localAgent?.stop();
      stopScheduler();
      await srv.close();
      await fx.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // When the desktop app starts us, it holds our stdin open. If the app quits or crashes, the pipe
  // closes and we shut down cleanly instead of running on as an orphan that holds the database.
  if (process.env.FEROXES_PARENT_PIPE === '1') {
    process.stdin.on('end', () => void shutdown());
    process.stdin.on('error', () => void shutdown());
    process.stdin.resume();
  }
}

const [command] = process.argv.slice(2);
switch (command) {
  case 'demo':
    await runDemo();
    break;
  case 'chat':
    await chat();
    break;
  case 'serve':
    await serve();
    break;
  case 'live': {
    // Live verification with real credentials: providers, voice, connectors (see live.ts).
    if (!process.env.FEROXES_DATA_DIR) process.env.FEROXES_DATA_DIR = feroxesConfigDir();
    const { formatRows, liveConnectors, liveProviders, liveVoice } = await import('./live.ts');
    const what = process.argv[3] ?? 'all';
    const env = loadEnv();
    const rows = [
      ...(what === 'all' || what === 'providers' ? await liveProviders(env, { quick: process.argv.includes('--quick') }) : []),
      ...(what === 'all' || what === 'voice' ? await liveVoice(env) : []),
      ...(what === 'all' || what === 'connectors' ? await liveConnectors(env) : []),
    ];
    process.stdout.write(`${formatRows(rows)}\n\n${rows.filter((r) => r.result === 'PASS').length} passed, ${rows.filter((r) => r.result === 'FAIL').length} failed, ${rows.filter((r) => r.result === 'SKIP').length} skipped\n`);
    process.exit(rows.some((r) => r.result === 'FAIL') ? 1 : 0);
  }
  case 'keygen':
    process.stdout.write(`FEROXES_MASTER_KEY=${Vault.generateKey()}\n`);
    break;
  default:
    process.stdout.write(`${HELP}\n`);
}
