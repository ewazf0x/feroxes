import type { LlmMessage, ToolCall } from '@feroxes/llm';
import type { TaintSource } from '@feroxes/policy';
import type { PriorityClass, Tier } from '@feroxes/shared';

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type RunTrigger = 'user_message' | 'schedule' | 'event' | 'subrun';

export interface RunLimits {
  maxSteps: number;
  maxCostNanoUsd: number;
  maxWallMs: number;
}

export interface RunTotals {
  steps: number;
  costNanoUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Run {
  id: string;
  sessionId: string;
  trigger: RunTrigger;
  priority: PriorityClass;
  status: RunStatus;
  goal?: string;
  tier?: Tier;
  modelId?: string;
  limits: RunLimits;
  totals: RunTotals;
  taint: TaintSource[];
  error?: string;
  waitingApprovalId?: string;
  resumeCount: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type StepKind = 'model' | 'tool' | 'approval' | 'note';

export interface Step {
  id: string;
  runId: string;
  idx: number;
  kind: StepKind;
  status: 'running' | 'done' | 'failed' | 'waiting';
  /** For model steps: the assistant text and tool calls. For tool steps: call and result. */
  data: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Screenshots returned by a tool; only the latest ones are sent to the model. */
  images?: { mediaType: string; dataBase64: string }[];
  providerState?: Extract<LlmMessage, { role: 'assistant' }>['providerState'];
  runId?: string;
  /** Exact memory block sent with this user turn, so later prompts stay byte-identical (prompt caching). */
  renderedContext?: string;
  meta?: { modelId?: string; costNanoUsd?: number; memoryIds?: string[] };
  createdAt: number;
}

export interface Session {
  id: string;
  channel: 'web' | 'voice' | 'system' | 'cli';
  title?: string;
  rollingSummary?: string;
  summaryThroughSeq: number;
  lastActivityAt: number;
  createdAt: number;
}

/** Postgres: `sessions`, `messages`, `agent_runs`, `agent_steps` (Phase 1 plan §5.2). */
export interface AgentStore {
  createSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  updateSession(s: Session): Promise<void>;
  appendMessage(m: Omit<SessionMessage, 'seq'>): Promise<SessionMessage>;
  messages(sessionId: string, opts?: { afterSeq?: number }): Promise<SessionMessage[]>;
  /** The one permitted change to a stored message: set its memory block once (NULL → value). */
  setRenderedContext(messageId: string, rendered: string, memoryIds: string[]): Promise<void>;

  putRun(r: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(filter: { statuses?: RunStatus[]; sessionId?: string }): Promise<Run[]>;
  putStep(s: Step): Promise<void>;
  steps(runId: string): Promise<Step[]>;
}

export class InMemoryAgentStore implements AgentStore {
  private readonly sessions = new Map<string, Session>();
  private readonly msgs = new Map<string, SessionMessage[]>();
  private readonly runs = new Map<string, Run>();
  private readonly stepRows = new Map<string, Step[]>();

  async createSession(s: Session) {
    this.sessions.set(s.id, structuredClone(s));
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : undefined;
  }
  async updateSession(s: Session) {
    this.sessions.set(s.id, structuredClone(s));
  }
  async appendMessage(m: Omit<SessionMessage, 'seq'>) {
    const list = this.msgs.get(m.sessionId) ?? [];
    const full: SessionMessage = { ...structuredClone(m), seq: list.length + 1 };
    list.push(full);
    this.msgs.set(m.sessionId, list);
    return structuredClone(full);
  }
  async messages(sessionId: string, opts: { afterSeq?: number } = {}) {
    return (this.msgs.get(sessionId) ?? []).filter((m) => m.seq > (opts.afterSeq ?? 0)).map((m) => structuredClone(m));
  }
  async setRenderedContext(messageId: string, rendered: string, memoryIds: string[]) {
    for (const list of this.msgs.values()) {
      const m = list.find((x) => x.id === messageId);
      if (m && m.renderedContext === undefined) {
        m.renderedContext = rendered;
        m.meta = { ...(m.meta ?? {}), memoryIds };
      }
    }
  }
  async putRun(r: Run) {
    this.runs.set(r.id, structuredClone(r));
  }
  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async listRuns(f: { statuses?: RunStatus[]; sessionId?: string }) {
    return [...this.runs.values()].filter((r) => (!f.statuses || f.statuses.includes(r.status)) && (!f.sessionId || r.sessionId === f.sessionId)).map((r) => structuredClone(r));
  }
  async putStep(s: Step) {
    const list = this.stepRows.get(s.runId) ?? [];
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = structuredClone(s);
    else list.push(structuredClone(s));
    this.stepRows.set(s.runId, list);
  }
  async steps(runId: string) {
    return (this.stepRows.get(runId) ?? []).map((s) => structuredClone(s));
  }
}
