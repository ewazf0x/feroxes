#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { formatUsd } from '@feroxes/shared';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';
import { runDemo } from './demo.ts';
import { Vault } from './vault.ts';

const HELP = `feroxes <command>

  demo      Run the end-to-end demo with mock providers (no API keys needed)
  chat      Chat with your real providers (keys from the environment)
  keygen    Print a new FEROXES_MASTER_KEY
  help      Show this help

Environment for "chat": ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY (+ GEMINI_TIER=paid|free),
OPENROUTER_API_KEY, OLLAMA_BASE_URL, FEROXES_TIMEZONE, FEROXES_DAILY_BUDGET_USD, FEROXES_PRESET.
Phase 1 note: data is kept in memory for now; the Postgres stores are the next milestone.`;

async function chat() {
  const fx = await createFeroxes(loadEnv());
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const session = await fx.runtime.createSession('cli');
  const enabled = fx.catalog.listProviders().map((p) => p.name).join(', ');
  process.stdout.write(`Feroxes — providers: ${enabled}. Commands: /usage /budget /memories /mode <normal|economy|background_paused> /stop /resume /quit\n`);

  fx.events.subscribe('run.delta', (e) => {
    if (e.payload.sessionId === session.id) process.stdout.write(e.payload.text);
  });
  fx.events.subscribe('run.reset', (e) => {
    if (e.payload.sessionId === session.id) process.stdout.write('\n[provider failed mid-answer; retrying with another]\n');
  });

  while (true) {
    const line = (await rl.question('\nyou › ')).trim();
    if (!line) continue;
    if (line === '/quit') break;
    if (line === '/stop') {
      await fx.system.stop('owner', 'cli');
      process.stdout.write('Stopped. Everything is blocked until /resume.\n');
      continue;
    }
    if (line === '/resume') {
      await fx.system.resume('owner', 'cli');
      process.stdout.write('Resumed.\n');
      continue;
    }
    if (line === '/usage') {
      for (const row of await fx.ledger.summarize({}, 'modelId')) process.stdout.write(`${row.key.padEnd(44)} ${row.calls} calls, ${row.errors} errors, ${formatUsd(row.cost)}\n`);
      continue;
    }
    if (line === '/budget') {
      for (const b of await fx.budget.status()) process.stdout.write(`${b.budget.name.padEnd(20)} ${formatUsd(b.counter.spent)} of ${formatUsd(b.budget.limit)} (${b.percent.toFixed(1)}%), resets ${new Date(b.resetsAt).toISOString()}\n`);
      process.stdout.write(`Power mode: ${fx.power.mode}\n`);
      continue;
    }
    if (line.startsWith('/mode ')) {
      const mode = line.slice(6).trim() as 'normal' | 'economy' | 'background_paused';
      fx.power.set(mode, 'owner', 'cli');
      process.stdout.write(`Power mode: ${fx.power.mode}\n`);
      continue;
    }
    if (line === '/memories') {
      await fx.flushMemory(session.id);
      for (const m of await fx.memory.store.list({ statuses: ['active'] })) process.stdout.write(`[m:${m.id.slice(-8)}] ${m.kind}: ${m.content}\n`);
      continue;
    }

    process.stdout.write('feroxes › ');
    let run = await (await fx.runtime.sendMessage(session.id, line)).done;
    while (run.status === 'waiting_approval' && run.waitingApprovalId) {
      const approval = await fx.approvals.get(run.waitingApprovalId);
      process.stdout.write(`\n\nApproval needed: ${approval?.preview.title}\n${approval?.preview.body ?? ''}\nReason: ${approval?.policyReason}\n`);
      const answer = (await rl.question('Approve? [y/N] ')).trim().toLowerCase();
      process.stdout.write('feroxes › ');
      const resumed = await fx.runtime.resolveApproval(run.waitingApprovalId, { approve: answer === 'y' || answer === 'yes' });
      if (!resumed) break;
      run = await resumed.done;
    }
    process.stdout.write(`\n[${run.modelId ?? '-'} · ${run.totals.steps} step(s) · ${formatUsd(run.totals.costNanoUsd)}${run.status !== 'completed' ? ` · ${run.status}` : ''}]\n`);
    for (const n of fx.notifications.splice(0)) process.stdout.write(`🔔 ${n.title}: ${n.body}\n`);
  }
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
