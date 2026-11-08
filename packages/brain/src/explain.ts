import type { AgentStore } from '@feroxes/agent';
import type { MemoryStore } from '@feroxes/memory';
import type { AuditLog } from '@feroxes/policy';
import { formatUsd } from '@feroxes/shared';

/**
 * "Why did you do that?" (architecture §9, interpretability): rebuilds the full chain of a run
 * from stored data — the request, the memories used, the model's stated intent before each tool
 * call, every policy decision and approval, costs, and the result. Nothing is re-generated.
 */
export async function explainRun(deps: { store: AgentStore; audit: AuditLog; memory: MemoryStore }, runId: string): Promise<string> {
  const run = await deps.store.getRun(runId);
  if (!run) return `No run ${runId}.`;
  const messages = (await deps.store.messages(run.sessionId)).filter((m) => m.runId === runId || m.role === 'user');
  const firstOwn = messages.findIndex((m) => m.runId === runId);
  const request = [...messages.slice(0, firstOwn === -1 ? undefined : firstOwn)].reverse().find((m) => m.role === 'user');
  // Approvals appear in the audit trail as ask → approved/denied entries.
  const audit = await deps.audit.query({ runId });

  const lines: string[] = [];
  lines.push(`Run ${run.id.slice(-8)} — ${run.trigger === 'user_message' ? 'you asked' : `started by ${run.trigger}`}${run.goal ? ` (goal: ${run.goal})` : ''}.`);
  if (request) lines.push(`Request: "${request.content.slice(0, 300)}"`);
  const memIds = request?.meta?.memoryIds ?? [];
  if (memIds.length) {
    const used = (await Promise.all(memIds.map((id) => deps.memory.get(id)))).filter(Boolean);
    lines.push(`Memories I used: ${used.map((m) => `"${m!.content.slice(0, 80)}" [m:${m!.id.slice(-8)}]`).join('; ')}`);
  }
  lines.push(`Model: ${run.modelId ?? 'none'} (tier ${run.tier ?? '?'}), ${run.totals.steps} step(s), ${formatUsd(run.totals.costNanoUsd)}.`);
  if (run.taint.length) lines.push(`Untrusted content read during the run: ${run.taint.map((t) => `${t.kind} ${t.source}`).join(', ')} — outward actions needed your approval.`);

  let step = 0;
  for (const m of messages.filter((x) => x.runId === runId)) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      step++;
      lines.push(`Step ${step}: ${m.content ? `my reasoning: "${m.content.slice(0, 240)}" → ` : ''}called ${m.toolCalls.map((c) => `${c.name.replace('__', '.')}(${JSON.stringify(c.args).slice(0, 120)})`).join(', ')}`);
    } else if (m.role === 'tool') {
      lines.push(`  result: ${m.isError ? 'ERROR ' : ''}${m.content.replace(/\s+/g, ' ').slice(0, 160)}`);
    } else if (m.role === 'assistant' && m.content) {
      lines.push(`Answer: "${m.content.slice(0, 300)}"`);
    }
  }
  if (audit.length) {
    lines.push('Policy decisions:');
    for (const a of audit) lines.push(`  #${a.seq} ${a.action}: ${a.decision} → ${a.outcome} (${a.summary.slice(0, 120)})`);
  }
  lines.push(`Outcome: ${run.status}${run.error ? ` (${run.error})` : ''}.`);
  return lines.join('\n');
}
