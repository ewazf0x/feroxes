/**
 * Untrusted content that entered a run's context. The set only grows during a run.
 * Kinds: web pages, emails and messages from other people, documents, device notifications.
 */
export interface TaintSource {
  kind: 'web' | 'email' | 'message' | 'document' | 'notification' | 'screen' | 'tool_output';
  source: string; // URL, sender, file name …
  at: number;
}

export class TaintSet {
  private readonly items: TaintSource[] = [];

  constructor(initial: TaintSource[] = []) {
    for (const t of initial) this.add(t);
  }

  add(t: TaintSource): void {
    if (!this.items.some((x) => x.kind === t.kind && x.source === t.source)) this.items.push({ ...t });
  }

  get tainted(): boolean {
    return this.items.length > 0;
  }

  list(): TaintSource[] {
    return this.items.map((t) => ({ ...t }));
  }

  toJSON(): TaintSource[] {
    return this.list();
  }
}
