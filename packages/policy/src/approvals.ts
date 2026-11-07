import { type Clock, HOUR, systemClock, uuidv7 } from '@feroxes/shared';
import type { RiskCategory } from './permissions.ts';
import type { TaintSource } from './taint.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalPreview {
  title: string;
  /** Exactly what will happen, e.g. the email text or the file path being deleted. */
  body?: string;
  fields?: Record<string, string>;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolCallId: string;
  tool: string;
  category: RiskCategory;
  args: unknown;
  preview: ApprovalPreview;
  agentReason: string;
  policyReason: string;
  taint: TaintSource[];
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  editedArgs?: unknown;
  note?: string;
}

export interface ApprovalStore {
  put(a: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  list(filter: { status?: ApprovalStatus; runId?: string }): Promise<ApprovalRequest[]>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly rows = new Map<string, ApprovalRequest>();
  async put(a: ApprovalRequest) {
    this.rows.set(a.id, structuredClone(a));
  }
  async get(id: string) {
    const a = this.rows.get(id);
    return a ? structuredClone(a) : undefined;
  }
  async list(f: { status?: ApprovalStatus; runId?: string }) {
    return [...this.rows.values()].filter((a) => (!f.status || a.status === f.status) && (!f.runId || a.runId === f.runId)).map((a) => structuredClone(a));
  }
}

export class ApprovalService {
  private readonly store: ApprovalStore;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly listeners = new Set<(a: ApprovalRequest) => void>();

  constructor(deps: { store: ApprovalStore; clock?: Clock; ttlMs?: number }) {
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
    this.ttlMs = deps.ttlMs ?? 24 * HOUR;
  }

  onChange(listener: (a: ApprovalRequest) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt' | 'expiresAt'>): Promise<ApprovalRequest> {
    const now = this.clock.now();
    const a: ApprovalRequest = { ...input, id: uuidv7(now), status: 'pending', createdAt: now, expiresAt: now + this.ttlMs };
    await this.store.put(a);
    this.listeners.forEach((l) => l(a));
    return a;
  }

  async decide(id: string, decision: { approve: boolean; editedArgs?: unknown; note?: string }): Promise<ApprovalRequest> {
    const a = await this.store.get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    const now = this.clock.now();
    if (a.status === 'pending' && now >= a.expiresAt) {
      a.status = 'expired';
      await this.store.put(a);
    }
    if (a.status !== 'pending') throw new Error(`approval ${id} is already ${a.status}`);
    a.status = decision.approve ? 'approved' : 'denied';
    a.decidedAt = now;
    if (decision.editedArgs !== undefined) a.editedArgs = decision.editedArgs;
    if (decision.note) a.note = decision.note;
    await this.store.put(a);
    this.listeners.forEach((l) => l(a));
    return a;
  }

  get(id: string) {
    return this.store.get(id);
  }

  pending() {
    return this.store.list({ status: 'pending' });
  }

  async expireOld(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const a of await this.store.list({ status: 'pending' })) {
      if (now >= a.expiresAt) {
        a.status = 'expired';
        await this.store.put(a);
        this.listeners.forEach((l) => l(a));
        n++;
      }
    }
    return n;
  }
}
