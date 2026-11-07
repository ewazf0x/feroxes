import { type Clock, type SystemState, systemClock } from '@feroxes/shared';

export interface StateChange {
  state: SystemState;
  previous: SystemState;
  actor: 'owner' | 'system';
  reason: string;
  at: number;
}

export interface SystemStateStore {
  load(): Promise<{ state: SystemState } | undefined>;
  save(change: StateChange): Promise<void>;
}

export class InMemorySystemStateStore implements SystemStateStore {
  history: StateChange[] = [];
  private readonly initial: SystemState;
  constructor(initial: SystemState = 'running') {
    this.initial = initial;
  }
  async load() {
    return { state: this.history.at(-1)?.state ?? this.initial };
  }
  async save(change: StateChange) {
    this.history.push(change);
  }
}

/**
 * The kill switch (architecture §9.4, Phase 1 plan §7.12). STOP aborts every registered
 * operation at once, is persisted (the Core restarts stopped), and only the owner can resume.
 * The Policy Gate also checks `state` on every call, as a backstop for any missed path.
 */
export class SystemControl {
  private current: SystemState = 'running';
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Set<(c: StateChange) => void>();
  private readonly store: SystemStateStore;
  private readonly clock: Clock;

  constructor(deps: { store: SystemStateStore; clock?: Clock }) {
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
  }

  async init(): Promise<SystemState> {
    this.current = (await this.store.load())?.state ?? 'running';
    return this.current;
  }

  get state(): SystemState {
    return this.current;
  }

  get stopped(): boolean {
    return this.current === 'stopped';
  }

  /**
   * Registers a cancellable operation (a run, a job, a stream). Returns its signal and an
   * unregister function. Starting work while stopped is refused.
   */
  track(id: string, parent?: AbortSignal): { signal: AbortSignal; done: () => void } {
    if (this.stopped) throw new Error('system is stopped');
    const controller = new AbortController();
    if (parent) {
      if (parent.aborted) controller.abort(parent.reason);
      else parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
    }
    this.active.set(id, controller);
    return { signal: controller.signal, done: () => this.active.delete(id) };
  }

  activeCount(): number {
    return this.active.size;
  }

  async stop(actor: StateChange['actor'], reason: string): Promise<{ aborted: number }> {
    const previous = this.current;
    this.current = 'stopped'; // flip first, so nothing new starts while we abort
    const aborted = this.active.size;
    for (const c of this.active.values()) c.abort(new Error(`system_stop: ${reason}`));
    this.active.clear();
    const change: StateChange = { state: 'stopped', previous, actor, reason, at: this.clock.now() };
    await this.store.save(change);
    for (const l of this.listeners) l(change);
    return { aborted };
  }

  /** Only the authenticated owner may resume; the API layer enforces re-authentication. */
  async resume(actor: 'owner', reason: string): Promise<void> {
    if (actor !== 'owner') throw new Error('only the owner can resume');
    if (!this.stopped) return;
    const change: StateChange = { state: 'running', previous: 'stopped', actor, reason, at: this.clock.now() };
    this.current = 'running';
    await this.store.save(change);
    for (const l of this.listeners) l(change);
  }

  onChange(listener: (c: StateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
