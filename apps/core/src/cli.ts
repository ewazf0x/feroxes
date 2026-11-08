#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { explainRun } from '@feroxes/brain';
import { formatUsd } from '@feroxes/shared';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';
import { runDemo } from './demo.ts';
import { Vault } from './vault.ts';

const HELP = `feroxes <command>

  demo      End-to-end demo with scripted providers and a simulated PC (no API keys needed)
  chat      Chat with your real providers; data is saved in FEROXES_DATA_DIR/feroxes.db
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

const [command] = process.argv.slice(2);
switch (command) {
  case 'demo':
    await runDemo();
    break;
  case 'chat':
    await chat();
    break;
  case 'keygen':
    process.stdout.write(`FEROXES_MASTER_KEY=${Vault.generateKey()}\n`);
    break;
  default:
    process.stdout.write(`${HELP}\n`);
}
