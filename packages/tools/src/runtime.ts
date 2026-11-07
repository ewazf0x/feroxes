import {
  type ApprovalPreview,
  type ApprovalService,
  type AuditLog,
  type PolicyEngine,
  type RiskCategory,
  type SystemControl,
  TaintSet,
} from '@feroxes/policy';
import { type Clock, type Logger, anySignal, errorMessage, noopLogger, systemClock, uuidv7 } from '@feroxes/shared';
import type { AnyTool, ToolContext, ToolResult } from './define.ts';
import { fromWireName } from './define.ts';
import type { ToolRegistry } from './registry.ts';

export type ToolCallStatus = 'running' | 'succeeded' | 'failed' | 'denied' | 'awaiting_approval' | 'cancelled';

export interface ToolCallRecord {
  id: string;
  runId: string;
  tool: string;
  args: unknown;
  idempotencyKey: string;
  status: ToolCallStatus;
  category: RiskCategory;
  result?: ToolResult;
  error?: string;
  approvalId?: string;
  artifactId?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Postgres: `tool_calls` with a unique index on idempotency_key. */
export interface ToolCallStore {
  byKey(idempotencyKey: string): Promise<ToolCallRecord | undefined>;
  put(record: ToolCallRecord): Promise<void>;
  list(runId: string): Promise<ToolCallRecord[]>;
}

export class InMemoryToolCallStore implements ToolCallStore {
  private readonly rows = new Map<string, ToolCallRecord>();
  async byKey(k: string) {
    const r = this.rows.get(k);
    return r ? structuredClone(r) : undefined;
  }
  async put(r: ToolCallRecord) {
    this.rows.set(r.idempotencyKey, structuredClone(r));
  }
  async list(runId: string) {
    return [...this.rows.values()].filter((r) => r.runId === runId).map((r) => structuredClone(r));
  }
}

export interface ArtifactStore {
  save(runId: string, content: string, mime: string): Promise<string>;
  read(id: string): Promise<string | undefined>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, string>();
  async save(_runId: string, content: string) {
    const id = uuidv7();
    this.rows.set(id, content);
    return id;
  }
  async read(id: string) {
    return this.rows.get(id);
  }
}

export interface InvocationRequest {
  runId: string;
  callId: string;
  /** Wire or canonical tool name. */
  tool: string;
  args: unknown;
  /** `${runId}:${stepIndex}:${callIndex}` — stable across crash and resume. */
  idempotencyKey: string;
}

export interface InvocationContext {
  signal: AbortSignal;
  taint: TaintSet;
  actor: 'agent' | 'owner' | 'scheduler';
  agentReason?: string;
  onProgress?: (message: string) => void;
}

export type InvocationOutcome =
  | { status: 'executed'; result: ToolResult; record: ToolCallRecord }
  | { status: 'awaiting_approval'; approvalId: string; record: ToolCallRecord }
  | { status: 'denied'; reason: string; record?: ToolCallRecord }
  | { status: 'invalid'; error: string };

export interface ToolRuntimeOptions {
  registry: ToolRegistry;
  policy: PolicyEngine;
  approvals: ApprovalService;
  audit: AuditLog;
  system: SystemControl;
  calls: ToolCallStore;
  artifacts: ArtifactStore;
  timeZone: string;
  clock?: Clock;
  logger?: Logger;
  /** Model-facing output is truncated beyond this many characters; the full text becomes an artifact. */
  maxContentChars?: number;
  defaultTimeoutMs?: number;
  /** Called for `notify`-level actions (in-app notification, push in Phase 2). */
  notify?: (message: { title: string; body: string; runId: string }) => void;
}

/**
 * The only path from anything in Feroxes to a side effect (architecture §5.6):
 * system check → validation → policy → approval or execution (idempotent) → audit → output shaping.
 */
export class ToolRuntime {
  private readonly o: Required<Omit<ToolRuntimeOptions, 'notify'>> & Pick<ToolRuntimeOptions, 'notify'>;

  constructor(options: ToolRuntimeOptions) {
    this.o = { clock: systemClock, logger: noopLogger, maxContentChars: 8000, defaultTimeoutMs: 60_000, ...options };
  }

  async invoke(req: InvocationRequest, ctx: InvocationContext): Promise<InvocationOutcome> {
    const name = fromWireName(req.tool);
    const tool = this.o.registry.get(name);
    if (!tool) return { status: 'invalid', error: `Unknown tool "${req.tool}". Available: ${this.o.registry.list().map((t) => t.name).join(', ')}` };

    // Idempotency: a call that already ran (e.g. before a crash) returns its stored result.
    const existing = await this.o.calls.byKey(req.idempotencyKey);
    if (existing?.status === 'succeeded' && existing.result) return { status: 'executed', result: existing.result, record: existing };
    if (existing?.status === 'awaiting_approval' && existing.approvalId) return { status: 'awaiting_approval', approvalId: existing.approvalId, record: existing };
    if (existing?.status === 'running' && !tool.idempotent) {
      return { status: 'denied', reason: 'This action may already have run before an interruption. The owner must verify it before it is retried.', record: existing };
    }

    if (this.o.system.stopped) {
      await this.audit(req, tool, tool.risk.category, 'deny', 'blocked', 'Feroxes is stopped', ctx);
      return { status: 'denied', reason: 'Feroxes is stopped. The owner must resume it.' };
    }

    const parsed = tool.input.safeParse(req.args);
    if (!parsed.success) {
      return { status: 'invalid', error: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
    }
    const args = parsed.data;
    const category = tool.riskFor?.(args) ?? tool.risk.category;
    const decision = this.o.policy.decide({ tool: tool.name, category, args, taint: ctx.taint, actor: ctx.actor });

    const record: ToolCallRecord = { id: req.callId, runId: req.runId, tool: tool.name, args, idempotencyKey: req.idempotencyKey, status: 'running', category, startedAt: this.o.clock.now() };

    if (decision.level === 'deny') {
      record.status = 'denied';
      record.finishedAt = this.o.clock.now();
      await this.o.calls.put(record);
      await this.audit(req, tool, category, 'deny', 'blocked', decision.reason, ctx);
      return { status: 'denied', reason: decision.reason, record };
    }

    if (decision.level === 'ask') {
      const preview: ApprovalPreview = tool.preview?.(args) ?? { title: `${tool.name}`, body: JSON.stringify(args, null, 2).slice(0, 4000) };
      const approval = await this.o.approvals.request({
        runId: req.runId,
        toolCallId: req.callId,
        tool: tool.name,
        category,
        args,
        preview,
        agentReason: ctx.agentReason ?? '',
        policyReason: decision.reason,
        taint: ctx.taint.list(),
      });
      record.status = 'awaiting_approval';
      record.approvalId = approval.id;
      await this.o.calls.put(record);
      await this.audit(req, tool, category, 'ask', 'pending', `${preview.title} — waiting for approval (${decision.reason})`, ctx);
      return { status: 'awaiting_approval', approvalId: approval.id, record };
    }

    return this.execute(tool, req, args, record, ctx, decision.level);
  }

  /** Runs a call the owner approved (with edited arguments, if any). Executes at most once. */
  async executeApproved(approvalId: string, ctx: Omit<InvocationContext, 'actor'>): Promise<InvocationOutcome> {
    const approval = await this.o.approvals.get(approvalId);
    if (!approval) return { status: 'invalid', error: `approval ${approvalId} not found` };
    const tool = this.o.registry.get(approval.tool);
    if (!tool) return { status: 'invalid', error: `tool ${approval.tool} no longer exists` };
    const key = (await this.findKeyForApproval(approval.runId, approvalId)) ?? `${approval.runId}:approval:${approvalId}`;
    const existing = await this.o.calls.byKey(key);
    if (existing?.status === 'succeeded' && existing.result) return { status: 'executed', result: existing.result, record: existing };

    const req: InvocationRequest = { runId: approval.runId, callId: approval.toolCallId, tool: approval.tool, args: approval.editedArgs ?? approval.args, idempotencyKey: key };
    const full: InvocationContext = { ...ctx, actor: 'owner' };

    if (approval.status === 'denied' || approval.status === 'expired') {
      const record: ToolCallRecord = { ...(existing ?? { id: req.callId, runId: req.runId, tool: tool.name, args: req.args, idempotencyKey: key, category: approval.category, startedAt: this.o.clock.now() }), status: 'denied', finishedAt: this.o.clock.now() };
      await this.o.calls.put(record);
      await this.audit(req, tool, approval.category, 'denied', 'blocked', `Owner ${approval.status === 'denied' ? 'denied' : 'did not answer'}: ${approval.preview.title}`, full);
      return { status: 'denied', reason: approval.status === 'denied' ? `The owner denied this action${approval.note ? `: ${approval.note}` : ''}.` : 'The approval request expired.', record };
    }
    if (approval.status !== 'approved') return { status: 'awaiting_approval', approvalId, record: existing! };
    if (this.o.system.stopped) return { status: 'denied', reason: 'Feroxes is stopped. The owner must resume it.' };

    const parsed = tool.input.safeParse(req.args);
    if (!parsed.success) return { status: 'invalid', error: `Edited arguments are invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
    const record: ToolCallRecord = { id: req.callId, runId: req.runId, tool: tool.name, args: parsed.data, idempotencyKey: key, status: 'running', category: approval.category, approvalId, startedAt: this.o.clock.now() };
    return this.execute(tool, req, parsed.data, record, full, 'approved');
  }

  private async findKeyForApproval(runId: string, approvalId: string): Promise<string | undefined> {
    return (await this.o.calls.list(runId)).find((r) => r.approvalId === approvalId)?.idempotencyKey;
  }

  private async execute(tool: AnyTool, req: InvocationRequest, args: unknown, record: ToolCallRecord, ctx: InvocationContext, level: 'allow' | 'notify' | 'approved'): Promise<InvocationOutcome> {
    await this.o.calls.put(record); // status running: a crash now is detectable at resume
    const timeout = AbortSignal.timeout(tool.timeoutMs ?? this.o.defaultTimeoutMs);
    const toolCtx: ToolContext = {
      runId: req.runId,
      callId: req.callId,
      idempotencyKey: req.idempotencyKey,
      signal: anySignal(ctx.signal, timeout),
      taint: ctx.taint,
      log: this.o.logger.child({ tool: tool.name, runId: req.runId }),
      timeZone: this.o.timeZone,
      progress: (m) => ctx.onProgress?.(m),
    };

    let result: ToolResult;
    try {
      result = await tool.execute(args, toolCtx);
    } catch (error) {
      const cancelled = ctx.signal.aborted;
      record.status = cancelled ? 'cancelled' : 'failed';
      record.error = timeout.aborted ? `timed out after ${tool.timeoutMs ?? this.o.defaultTimeoutMs} ms` : errorMessage(error);
      record.finishedAt = this.o.clock.now();
      await this.o.calls.put(record);
      await this.audit(req, tool, record.category, level, 'failure', `${tool.name} failed: ${record.error}`, ctx);
      result = { content: `Error: ${record.error}`, isError: true };
      return { status: 'executed', result, record };
    }

    for (const t of result.taint ?? []) ctx.taint.add(t);
    if (tool.risk.untrustedOutput && !(result.taint?.length)) ctx.taint.add({ kind: 'tool_output', source: tool.name, at: this.o.clock.now() });

    if (result.content.length > this.o.maxContentChars) {
      const artifactId = await this.o.artifacts.save(req.runId, result.content, 'text/plain');
      record.artifactId = artifactId;
      result = { ...result, content: `${result.content.slice(0, this.o.maxContentChars)}\n\n[Truncated: ${result.content.length} characters in total. Full output saved as artifact ${artifactId}.]` };
    }

    record.status = result.isError ? 'failed' : 'succeeded';
    record.result = result;
    record.finishedAt = this.o.clock.now();
    await this.o.calls.put(record);
    await this.audit(req, tool, record.category, level, result.isError ? 'failure' : 'success', `${tool.name}: ${result.content.slice(0, 160)}`, ctx);
    if (level === 'notify') this.o.notify?.({ title: `Feroxes used ${tool.name}`, body: result.content.slice(0, 300), runId: req.runId });
    return { status: 'executed', result, record };
  }

  private async audit(req: InvocationRequest, tool: AnyTool, category: RiskCategory, decision: 'allow' | 'notify' | 'ask' | 'deny' | 'approved' | 'denied', outcome: 'success' | 'failure' | 'pending' | 'blocked', summary: string, ctx: InvocationContext) {
    await this.o.audit.append({
      actor: ctx.actor === 'owner' ? 'owner' : ctx.actor,
      action: tool.name,
      category,
      decision,
      outcome,
      summary,
      runId: req.runId,
      toolCallId: req.callId,
      details: { args: req.args, idempotencyKey: req.idempotencyKey, ...(ctx.taint.tainted ? { taint: ctx.taint.list() } : {}) },
    });
  }
}

export const newCallId = () => uuidv7();
export { TaintSet };
