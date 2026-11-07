import { defineTool, z } from '../define.ts';

export const timeNow = defineTool({
  name: 'time.now',
  toolset: 'time',
  description: "Get the current date and time, in the owner's time zone or a given IANA time zone.",
  input: z.object({ timeZone: z.string().optional().describe('IANA time zone, e.g. "Europe/Paris". Defaults to the owner\'s time zone.') }),
  risk: { category: 'read', reversible: true },
  idempotent: true,
  async execute({ timeZone }, ctx) {
    const tz = timeZone ?? ctx.timeZone;
    try {
      const now = new Date();
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(now);
      return { content: `${local} (${tz}); UTC ${now.toISOString()}`, data: { iso: now.toISOString(), timeZone: tz } };
    } catch {
      return { content: `Unknown time zone "${tz}".`, isError: true };
    }
  },
});

/** The run's own checklist, so the agent can plan multi-step work and the UI can show progress. */
export interface PlanStore {
  set(runId: string, items: { text: string; done: boolean }[]): void;
  get(runId: string): { text: string; done: boolean }[];
}

export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, { text: string; done: boolean }[]>();
  set(runId: string, items: { text: string; done: boolean }[]) {
    this.plans.set(runId, items.map((i) => ({ ...i })));
  }
  get(runId: string) {
    return (this.plans.get(runId) ?? []).map((i) => ({ ...i }));
  }
}

export function planUpdate(store: PlanStore) {
  return defineTool({
    name: 'plan.update',
    toolset: 'plan',
    description: 'Write or update your checklist for the current task. Send the full list each time. Use it for tasks with three or more steps.',
    input: z.object({ items: z.array(z.object({ text: z.string().min(1).max(300), done: z.boolean() })).min(1).max(30) }),
    risk: { category: 'internal_write', reversible: true },
    idempotent: true,
    async execute({ items }, ctx) {
      store.set(ctx.runId, items);
      const open = items.filter((i) => !i.done).length;
      return { content: `Plan saved: ${items.length} steps, ${open} open.`, data: { items } };
    },
  });
}

export function notifyOwner(send: (n: { title: string; body: string; urgency: 'low' | 'normal' | 'high'; runId: string }) => void) {
  return defineTool({
    name: 'notify.owner',
    toolset: 'notify',
    description: 'Send the owner an in-app notification. Use for results of background work or things that need attention later, not for normal chat replies.',
    input: z.object({ title: z.string().min(1).max(120), body: z.string().max(2000), urgency: z.enum(['low', 'normal', 'high']).default('normal') }),
    risk: { category: 'internal_write', reversible: true },
    idempotent: false,
    async execute({ title, body, urgency }, ctx) {
      send({ title, body, urgency, runId: ctx.runId });
      return { content: 'Notification sent.' };
    },
  });
}
