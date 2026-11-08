import {
  AllCandidatesFailedError,
  BudgetApprovalNeededError,
  BudgetBlockedError,
  DeferredError,
  type ModelRouter,
  NoCandidatesError,
  ProviderError,
  type ToolCall,
  classifyComplexity,
} from '@feroxes/llm';
import type { ApprovalService, SystemControl } from '@feroxes/policy';
import { TaintSet } from '@feroxes/policy';
import {
  type Clock,
  type EventBus,
  type Logger,
  type PriorityClass,
  type Sensitivity,
  type Tier,
  canonicalJson,
  errorMessage,
  formatUsd,
  isBackground,
  noopLogger,
  sensitivityRank,
  systemClock,
  usd,
  uuidv7,
} from '@feroxes/shared';
import { type ToolRegistry, type ToolRuntime, fromWireName } from '@feroxes/tools';
import type { ContextBuilder } from './context.ts';
import type { AgentStore, Run, RunLimits, RunStatus, RunTrigger, Session, SessionMessage, Step } from './store.ts';

export type AgentEvents = {
  'run.status': { runId: string; sessionId: string; status: RunStatus; error?: string; totals: Run['totals'] };
  'run.delta': { runId: string; sessionId: string; text: string };
  'run.reset': { runId: string; sessionId: string; reason: string };
  'run.tool': { runId: string; sessionId: string; tool: string; status: string; summary: string };
  'run.approval': { runId: string; sessionId: string; approvalId: string };
  'message.created': { sessionId: string; messageId: string; role: SessionMessage['role'] };
};

export const DEFAULT_LIMITS: Record<'interactive' | 'background', RunLimits> = {
  interactive: { maxSteps: 12, maxCostNanoUsd: usd(0.5), maxWallMs: 10 * 60_000 },
  background: { maxSteps: 6, maxCostNanoUsd: usd(0.1), maxWallMs: 15 * 60_000 },
};

export interface AgentRuntimeOptions {
  store: AgentStore;
  router: ModelRouter;
  tools: ToolRuntime;
  registry: ToolRegistry;
  context: ContextBuilder;
  system: SystemControl;
  approvals: ApprovalService;
  events: EventBus<AgentEvents>;
  clock?: Clock;
  logger?: Logger;
  /** Sensitivity assumed for conversation text itself (the owner's words are personal by default). */
  conversationSensitivity?: Sensitivity;
  /** Toolsets offered on each turn; a function lets them follow which devices are online. */
  toolsets?: string[] | (() => string[]);
  /** Called after an interactive turn finishes, e.g. to schedule debounced memory extraction. */
  onTurnComplete?: (info: { sessionId: string; runId: string }) => void;
}

interface RunState {
  controller: AbortController;
  done: Promise<Run>;
}

export class AgentRuntime {
  private readonly o: Required<Omit<AgentRuntimeOptions, 'onTurnComplete'>> & Pick<AgentRuntimeOptions, 'onTurnComplete'>;
  private readonly active = new Map<string, RunState>();

  constructor(options: AgentRuntimeOptions) {
    this.o = {
      clock: systemClock,
      logger: noopLogger,
      conversationSensitivity: 'private',
      toolsets: ['memory', 'time', 'plan', 'notify', 'files', 'web'],
      ...options,
    };
  }

  async createSession(channel: Session['channel'] = 'web', title?: string): Promise<Session> {
    const now = this.o.clock.now();
    const session: Session = { id: uuidv7(now), channel, ...(title ? { title } : {}), summaryThroughSeq: 0, lastActivityAt: now, createdAt: now };
    await this.o.store.createSession(session);
    return session;
  }

  /** Stores the owner's message and starts an interactive run. `done` resolves when the run stops. */
  async sendMessage(sessionId: string, text: string, opts: { tier?: Tier | 'auto' } = {}): Promise<{ runId: string; messageId: string; done: Promise<Run> }> {
    const session = await this.o.store.getSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    const active = await this.o.store.listRuns({ sessionId, statuses: ['running', 'queued', 'waiting_approval'] });
    if (active.some((r) => r.status === 'running' || r.status === 'queued')) throw new Error('A run is already in progress in this session.');
    // A new message while an approval waits means the owner moved on: the old approval is dropped.
    for (const r of active.filter((x) => x.status === 'waiting_approval')) await this.finish(r, 'cancelled', 'superseded by a new message');

    const message = await this.o.store.appendMessage({ id: uuidv7(), sessionId, role: 'user', content: text, createdAt: this.o.clock.now() });
    this.o.events.publish('message.created', { sessionId, messageId: message.id, role: 'user' });
    await this.o.store.updateSession({ ...session, lastActivityAt: this.o.clock.now(), ...(session.title ? {} : { title: text.slice(0, 60) }) });
    const run = await this.newRun({ sessionId, trigger: 'user_message', priority: 'interactive', ...(opts.tier && opts.tier !== 'auto' ? { tier: opts.tier } : {}) });
    return { runId: run.id, messageId: message.id, done: this.launch(run.id) };
  }

  /** Background or scheduled goal, in its own system session. */
  async startBackground(goal: string, opts: { priority?: PriorityClass; trigger?: RunTrigger; sessionId?: string } = {}): Promise<{ runId: string; done: Promise<Run> }> {
    const session = opts.sessionId ? (await this.o.store.getSession(opts.sessionId))! : await this.createSession('system', goal.slice(0, 60));
    await this.o.store.appendMessage({ id: uuidv7(), sessionId: session.id, role: 'user', content: goal, createdAt: this.o.clock.now() });
    const run = await this.newRun({ sessionId: session.id, trigger: opts.trigger ?? 'schedule', priority: opts.priority ?? 'routine', goal });
    return { runId: run.id, done: this.launch(run.id) };
  }

  async cancel(runId: string, reason = 'cancelled by owner'): Promise<void> {
    const state = this.active.get(runId);
    if (state) {
      state.controller.abort(new Error(reason));
      await state.done;
      return;
    }
    const run = await this.o.store.getRun(runId);
    if (run && (run.status === 'waiting_approval' || run.status === 'queued' || run.status === 'interrupted')) await this.finish(run, 'cancelled', reason);
  }

  /** Records the owner's decision and resumes the waiting run. */
  async resolveApproval(approvalId: string, decision: { approve: boolean; editedArgs?: unknown; note?: string; scope?: 'once' | 'task' }): Promise<{ runId: string; done: Promise<Run> } | undefined> {
    const approval = await this.o.approvals.decide(approvalId, decision);
    const run = await this.o.store.getRun(approval.runId);
    if (!run || run.status !== 'waiting_approval' || run.waitingApprovalId !== approvalId) return undefined;
    return { runId: run.id, done: this.launch(run.id) };
  }

  /** At boot: runs that were `running` when the process died (Phase 1 plan §7.12). */
  async recoverAfterRestart(): Promise<{ interrupted: string[]; resumed: string[] }> {
    const report = { interrupted: [] as string[], resumed: [] as string[] };
    for (const run of await this.o.store.listRuns({ statuses: ['running', 'queued'] })) {
      const steps = await this.o.store.steps(run.id);
      const last = steps.at(-1);
      const interrupted: Run = { ...run, status: 'interrupted', error: 'Feroxes restarted while this run was in progress' };
      await this.o.store.putRun(interrupted);
      report.interrupted.push(run.id);
      // A model step can safely run again; tool steps are protected by idempotency keys.
      const safe = !last || last.kind === 'model' || last.status === 'done';
      if (isBackground(run.priority) && safe && run.resumeCount < 2) {
        report.resumed.push(run.id);
        void this.launch(run.id);
      }
    }
    return report;
  }

  async resumeInterrupted(runId: string): Promise<Promise<Run>> {
    const run = await this.o.store.getRun(runId);
    if (!run || run.status !== 'interrupted') throw new Error('run is not interrupted');
    return this.launch(runId);
  }

  // ---------------------------------------------------------------------------

  private async newRun(input: { sessionId: string; trigger: RunTrigger; priority: PriorityClass; goal?: string; tier?: Tier }): Promise<Run> {
    const run: Run = {
      id: uuidv7(),
      sessionId: input.sessionId,
      trigger: input.trigger,
      priority: input.priority,
      status: 'queued',
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
      limits: isBackground(input.priority) ? DEFAULT_LIMITS.background : DEFAULT_LIMITS.interactive,
      totals: { steps: 0, costNanoUsd: 0, inputTokens: 0, outputTokens: 0 },
      taint: [],
      resumeCount: 0,
      createdAt: this.o.clock.now(),
    };
    await this.o.store.putRun(run);
    this.publishStatus(run);
    return run;
  }

  private launch(runId: string): Promise<Run> {
    const existing = this.active.get(runId);
    if (existing) return existing.done;
    const controller = new AbortController();
    const done = this.loop(runId, controller).finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, done });
    return done;
  }

  private async loop(runId: string, controller: AbortController): Promise<Run> {
    let run = (await this.o.store.getRun(runId))!;
    let tracked: { signal: AbortSignal; done: () => void };
    try {
      tracked = this.o.system.track(runId, controller.signal);
    } catch {
      return this.finish(run, 'cancelled', 'Feroxes is stopped');
    }
    const signal = tracked.signal;
    const taint = new TaintSet(run.taint);
    const startedAt = this.o.clock.now();
    run = { ...run, status: 'running', startedAt: run.startedAt ?? startedAt, resumeCount: run.status === 'interrupted' || run.status === 'waiting_approval' ? run.resumeCount + 1 : run.resumeCount };
    delete run.waitingApprovalId;
    await this.o.store.putRun(run);
    this.publishStatus(run);

    try {
      // Resume: finish the tool calls of the last model step before asking the model again.
      const pending = await this.pendingToolStep(run.id);
      if (pending) {
        const paused = await this.processToolCalls(run, pending, taint, signal);
        if (paused) return paused;
      }

      while (true) {
        if (signal.aborted) throw signal.reason ?? new Error('cancelled');
        if (run.totals.steps >= run.limits.maxSteps) return this.stopWithNote(run, `I stopped after ${run.totals.steps} steps (the limit for one request). Ask me to continue if you want me to keep going.`);
        if (run.totals.costNanoUsd >= run.limits.maxCostNanoUsd) return this.stopWithNote(run, `I stopped because this request reached its cost limit (${formatUsd(run.limits.maxCostNanoUsd)}). Ask me to continue to allow more.`);
        if (this.o.clock.now() - startedAt > run.limits.maxWallMs) return this.stopWithNote(run, 'I stopped because this request took too long.');

        const session = (await this.o.store.getSession(run.sessionId))!;
        if (!run.tier) {
          // A run picks its tier once, from the owner's message, and keeps it for every step:
          // coherent behaviour and a stable prompt-cache prefix.
          const lastUser = [...(await this.o.store.messages(session.id))].reverse().find((m) => m.role === 'user');
          run = { ...run, tier: classifyComplexity([{ role: 'user', content: lastUser?.content ?? '' }]).tier };
          await this.o.store.putRun(run);
        }
        // Only providers allowed to see the conversation itself are candidates. Memories may be
        // included up to the first candidate's limit, and the request is labeled with that level,
        // so a failover can never send them to a provider with a lower limit (architecture §7.7).
        const plan = this.o.router.plan({ route: 'chat.turn', messages: [], sensitivity: this.o.conversationSensitivity, ...(run.tier ? { tier: run.tier } : {}), attribution: { taskType: 'chat' } });
        const maxSensitivity = plan.candidates[0]!.provider.maxSensitivity;
        const ctx = await this.o.context.build({ session, maxSensitivity, signal });

        // Store the memory block with the user message the first time it is computed.
        if (ctx.renderedContext !== undefined) await this.saveRenderedContext(session.id, ctx.renderedContext, ctx.memoryIds);

        const stepIdx = run.totals.steps;
        const step: Step = { id: uuidv7(), runId: run.id, idx: stepIdx, kind: 'model', status: 'running', data: {}, startedAt: this.o.clock.now() };
        await this.o.store.putStep(step);

        let text = '';
        let toolCalls: ToolCall[] = [];
        let finish: Awaited<ReturnType<ModelRouter['generate']>>['finish'] | undefined;
        const requestSensitivity = sensitivityRank(maxSensitivity) > sensitivityRank(this.o.conversationSensitivity) ? maxSensitivity : this.o.conversationSensitivity;
        for await (const ev of this.o.router.stream({
          route: 'chat.turn',
          priority: run.priority,
          ...(run.tier ? { tier: run.tier } : {}),
          messages: ctx.messages,
          tools: this.o.registry.specs(typeof this.o.toolsets === 'function' ? this.o.toolsets() : this.o.toolsets),
          sensitivity: requestSensitivity,
          cacheBreakpoints: ctx.cacheBreakpoints,
          cacheKey: session.id,
          attribution: { taskType: 'chat', runId: run.id, sessionId: session.id },
          signal,
        })) {
          if (ev.type === 'text-delta') {
            text += ev.text;
            this.o.events.publish('run.delta', { runId: run.id, sessionId: session.id, text: ev.text });
          } else if (ev.type === 'tool-call') toolCalls.push(ev.call);
          else if (ev.type === 'reset') {
            text = '';
            toolCalls = [];
            this.o.events.publish('run.reset', { runId: run.id, sessionId: session.id, reason: ev.reason });
          } else if (ev.type === 'finish') finish = ev;
        }
        if (!finish) throw new ProviderError('server_error', 'model stream ended without finishing');

        const assistant = await this.o.store.appendMessage({
          id: uuidv7(),
          sessionId: session.id,
          role: 'assistant',
          content: text,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(finish.providerState !== undefined ? { providerState: { providerKind: finish.providerKind, data: finish.providerState } } : {}),
          runId: run.id,
          meta: { modelId: finish.modelId, costNanoUsd: finish.costNanoUsd, memoryIds: ctx.memoryIds },
          createdAt: this.o.clock.now(),
        });
        this.o.events.publish('message.created', { sessionId: session.id, messageId: assistant.id, role: 'assistant' });

        run = {
          ...run,
          modelId: finish.modelId,
          totals: {
            steps: run.totals.steps + 1,
            costNanoUsd: run.totals.costNanoUsd + finish.costNanoUsd,
            inputTokens: run.totals.inputTokens + finish.usage.inputTokens,
            outputTokens: run.totals.outputTokens + finish.usage.outputTokens,
          },
        };
        await this.o.store.putStep({ ...step, status: 'done', data: { messageId: assistant.id, toolCalls, processed: 0, modelId: finish.modelId, costNanoUsd: finish.costNanoUsd, attempts: finish.attempts.length }, finishedAt: this.o.clock.now() });
        await this.o.store.putRun(run);

        if (toolCalls.length === 0) {
          const done = await this.finish(run, 'completed');
          if (run.priority === 'interactive') this.o.onTurnComplete?.({ sessionId: session.id, runId: run.id });
          return done;
        }

        const stored = (await this.o.store.steps(run.id)).find((s) => s.id === step.id)!;
        const paused = await this.processToolCalls(run, stored, taint, signal);
        if (paused) return paused;
        run = (await this.o.store.getRun(run.id))!;
      }
    } catch (error) {
      return this.handleError(run.id, error, signal);
    } finally {
      tracked.done();
    }
  }

  /** Executes a model step's tool calls in order. Returns the run if it paused for approval. */
  private async processToolCalls(run: Run, step: Step, taint: TaintSet, signal: AbortSignal): Promise<Run | undefined> {
    const calls = (step.data.toolCalls as ToolCall[]) ?? [];
    let processed = (step.data.processed as number) ?? 0;
    const approvalFor = step.data.approvalFor as { index: number; approvalId: string } | undefined;

    for (let i = processed; i < calls.length; i++) {
      const call = calls[i]!;
      const key = `${run.id}:${step.idx}:${i}`;
      let outcome;
      if (approvalFor && approvalFor.index === i) {
        outcome = await this.o.tools.executeApproved(approvalFor.approvalId, { signal, taint });
      } else {
        if (this.isLooping(calls, i, await this.previousCalls(run.id, step.idx))) {
          outcome = { status: 'invalid' as const, error: 'You already called this tool with the same arguments several times. Stop and tell the owner what is blocking you.' };
        } else {
          outcome = await this.o.tools.invoke({ runId: run.id, callId: call.id, tool: call.name, args: call.args, idempotencyKey: key }, { signal, taint, actor: 'agent', agentReason: lastAssistantText(await this.o.store.messages(run.sessionId)) });
        }
      }

      if (outcome.status === 'awaiting_approval') {
        await this.o.store.putStep({ ...step, data: { ...step.data, processed: i, approvalFor: { index: i, approvalId: outcome.approvalId } } });
        const waiting: Run = { ...run, status: 'waiting_approval', waitingApprovalId: outcome.approvalId, taint: taint.list() };
        await this.o.store.putRun(waiting);
        this.o.events.publish('run.approval', { runId: run.id, sessionId: run.sessionId, approvalId: outcome.approvalId });
        this.o.events.publish('run.tool', { runId: run.id, sessionId: run.sessionId, tool: fromWireName(call.name), status: 'awaiting_approval', summary: 'waiting for your approval' });
        this.publishStatus(waiting);
        return waiting;
      }

      const content =
        outcome.status === 'executed' ? outcome.result.content : outcome.status === 'denied' ? `Not done: ${outcome.reason}` : `Error: ${outcome.error}`;
      const isError = outcome.status !== 'executed' || outcome.result.isError === true;
      const images = outcome.status === 'executed' ? outcome.result.images : undefined;
      await this.o.store.appendMessage({ id: uuidv7(), sessionId: run.sessionId, role: 'tool', content, toolCallId: call.id, toolName: call.name, ...(isError ? { isError: true } : {}), ...(images?.length ? { images } : {}), runId: run.id, createdAt: this.o.clock.now() });
      this.o.events.publish('run.tool', { runId: run.id, sessionId: run.sessionId, tool: fromWireName(call.name), status: outcome.status, summary: content.slice(0, 200) });
      processed = i + 1;
      const { approvalFor: _drop, ...rest } = step.data;
      step = { ...step, data: { ...rest, processed } };
      await this.o.store.putStep(step);
    }
    await this.o.store.putRun({ ...(await this.o.store.getRun(run.id))!, taint: taint.list() });
    return undefined;
  }

  private async pendingToolStep(runId: string): Promise<Step | undefined> {
    const last = (await this.o.store.steps(runId)).at(-1);
    if (!last || last.kind !== 'model' || last.status !== 'done') return undefined;
    const calls = (last.data.toolCalls as ToolCall[] | undefined) ?? [];
    return (last.data.processed as number) < calls.length ? last : undefined;
  }

  private async previousCalls(runId: string, beforeIdx: number): Promise<ToolCall[]> {
    return (await this.o.store.steps(runId)).filter((s) => s.kind === 'model' && s.idx < beforeIdx).flatMap((s) => (s.data.toolCalls as ToolCall[] | undefined) ?? []);
  }

  private isLooping(calls: ToolCall[], i: number, previous: ToolCall[]): boolean {
    const sig = (c: ToolCall) => `${c.name}:${canonicalJson(c.args)}`;
    const target = sig(calls[i]!);
    return [...previous, ...calls.slice(0, i)].filter((c) => sig(c) === target).length >= 2;
  }

  private async handleError(runId: string, error: unknown, signal: AbortSignal): Promise<Run> {
    const run = (await this.o.store.getRun(runId))!;
    if (signal.aborted || (error instanceof ProviderError && error.errorClass === 'cancelled')) {
      const reason = this.o.system.stopped ? 'Feroxes was stopped' : errorMessage(signal.reason ?? error);
      return this.finish(run, 'cancelled', reason);
    }
    if (error instanceof BudgetApprovalNeededError) {
      return this.stopWithNote(run, `Your budget "${error.budgetName}" is used up (${formatUsd(error.spentNanoUsd)} of ${formatUsd(error.limitNanoUsd)}). You can raise it or allow extra spending in Settings → Budgets, or wait until it resets.`, 'failed', 'budget_approval_needed');
    }
    if (error instanceof BudgetBlockedError || error instanceof DeferredError) {
      return this.finish(run, 'failed', errorMessage(error));
    }
    if (error instanceof AllCandidatesFailedError || error instanceof NoCandidatesError) {
      this.o.logger.error('no model available', { runId, error: errorMessage(error) });
      return this.stopWithNote(run, `I couldn't reach any AI provider just now (${errorMessage(error)}). Check Settings → Providers; I'll work again as soon as one is available.`, 'failed', 'no_model');
    }
    this.o.logger.error('run failed', { runId, error: errorMessage(error) });
    return this.stopWithNote(run, `Something went wrong: ${errorMessage(error)}`, 'failed', errorMessage(error));
  }

  private async stopWithNote(run: Run, note: string, status: RunStatus = 'completed', error?: string): Promise<Run> {
    if (run.priority === 'interactive') {
      const m = await this.o.store.appendMessage({ id: uuidv7(), sessionId: run.sessionId, role: 'assistant', content: note, runId: run.id, meta: {}, createdAt: this.o.clock.now() });
      this.o.events.publish('message.created', { sessionId: run.sessionId, messageId: m.id, role: 'assistant' });
    }
    return this.finish(run, status, error);
  }

  private async finish(run: Run, status: RunStatus, error?: string): Promise<Run> {
    const latest = (await this.o.store.getRun(run.id)) ?? run;
    const done: Run = { ...latest, status, finishedAt: this.o.clock.now(), ...(error ? { error } : {}) };
    delete done.waitingApprovalId;
    await this.o.store.putRun(done);
    this.publishStatus(done);
    return done;
  }

  private publishStatus(run: Run) {
    this.o.events.publish('run.status', { runId: run.id, sessionId: run.sessionId, status: run.status, ...(run.error ? { error: run.error } : {}), totals: run.totals });
  }

  private async saveRenderedContext(sessionId: string, rendered: string, memoryIds: string[]) {
    const msgs = await this.o.store.messages(sessionId);
    const latestUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (latestUser && latestUser.renderedContext === undefined) {
      await this.o.store.setRenderedContext(latestUser.id, rendered, memoryIds);
    }
  }
}

function lastAssistantText(messages: SessionMessage[]): string {
  return [...messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content.slice(0, 500) ?? '';
}
