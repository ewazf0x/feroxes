import { api } from './api.ts';
import { type Signal, append, effect, h, list, signal } from './core.ts';
import { icon } from './icons.ts';
import { on, status, toast } from './store.ts';

interface Msg {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolName?: string;
  isError?: boolean;
  meta?: { modelId?: string; costNanoUsd?: number; memoryIds?: string[] };
}
interface Approval {
  id: string;
  tool: string;
  category: string;
  preview: { title: string; body?: string };
  policyReason: string;
  taint: { kind: string; source: string }[];
}

/** Minimal, safe markdown: escapes HTML, then code blocks, inline code, bold, links, memory chips. */
function renderMarkdown(text: string): DocumentFragment {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      pre.textContent = part.replace(/^[\w-]*\n/, '');
      frag.appendChild(pre);
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.innerHTML = esc(para)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\(m:([0-9a-f]{6,8})\)/g, '<span class="mem-chip" title="memory $1">m:$1</span>')
        .replace(/\n/g, '<br>');
      frag.appendChild(p);
    }
  });
  return frag;
}

export function chatScreen(): Node {
  const messages = signal<Msg[]>([]);
  const streaming = signal<string>('');
  const approvals = signal<Approval[]>([]);
  const sessionId = signal<string>('');
  const busy = signal(false);
  const scroller = h('div', { class: 'chat-scroll' });

  const reload = async (id: string) => {
    messages.set(await api<Msg[]>(`/sessions/${id}/messages`));
    queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }));
  };

  void (async () => {
    const sessions = await api<{ id: string }[]>('/sessions').catch(() => []);
    const id = sessions[0]?.id ?? (await api<{ id: string }>('/sessions', { body: {} })).id;
    sessionId.set(id);
    await reload(id);
  })();

  on<{ runId: string; sessionId: string; text: string }>('run.delta', (d) => {
    if (d.sessionId === sessionId.peek()) streaming.update((s) => s + d.text);
  });
  on<{ sessionId: string; role: string }>('message.created', (d) => {
    if (d.sessionId !== sessionId.peek()) return;
    streaming.set('');
    void reload(d.sessionId);
  });
  on<{ sessionId: string; reason: string }>('run.reset', (d) => d.sessionId === sessionId.peek() && streaming.set(''));
  on<{ runId: string; approvalId: string; sessionId: string }>('run.approval', () => void refreshApprovals());
  on<{ sessionId: string; status: string }>('run.status', (d) => {
    if (d.sessionId === sessionId.peek() && d.status !== 'running') {
      busy.set(false);
      streaming.set('');
    }
  });
  const refreshApprovals = async () => approvals.set(await api<Approval[]>('/approvals').catch(() => []));
  void refreshApprovals();

  const send = async (text: string) => {
    if (!text.trim() || busy.peek() || !sessionId.peek()) return;
    busy.set(true);
    try {
      await api(`/sessions/${sessionId.peek()}/messages`, { body: { text } });
    } catch (e) {
      busy.set(false);
      toast({ title: 'Could not send', body: (e as Error).message, urgency: 'high' });
    }
  };
  const decide = async (id: string, approve: boolean, scope?: 'task') => {
    approvals.update((xs) => xs.filter((a) => a.id !== id));
    await api(`/approvals/${id}`, { body: { approve, ...(scope ? { scope } : {}) } }).catch((e) => toast({ title: 'Approval failed', body: (e as Error).message, urgency: 'high' }));
  };

  const textarea = h('textarea', {
    rows: 1,
    placeholder: 'Message Feroxes…  (Enter to send, Shift+Enter for a new line)',
    'aria-label': 'Message',
    on: {
      input: (e: Event) => {
        const t = e.target as HTMLTextAreaElement;
        t.style.height = 'auto';
        t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
      },
      keydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const t = e.target as HTMLTextAreaElement;
          void send(t.value);
          t.value = '';
          t.style.height = 'auto';
        }
      },
    },
  }) as HTMLTextAreaElement;

  append(scroller, [
    () => {
      const msgs = messages();
      const stream = streaming();
      const nodes: Node[] = [h('div', { class: 'chat-inner' },
        msgs.length === 0 && !stream ? h('div', { class: 'empty' }, 'Say hello to Feroxes, or press ⌘K for commands.') : false,
        ...groupMessages(msgs).map(renderGroup),
        stream ? h('div', { class: 'msg assistant' }, h('div', { class: 'msg-role' }, 'Feroxes'), h('div', { class: 'bubble cursor' }, renderMarkdown(stream))) : false,
      )];
      return nodes;
    },
  ]);

  const approvalBar = h('div', {});
  append(approvalBar, [
    list<Approval>(() => approvals(), (a) => a.id, (a) => renderApproval(a(), decide)),
  ]);

  return h('div', { class: 'chat' },
    scroller,
    h('div', { class: 'composer' },
      h('div', { class: 'composer-inner' },
        approvalBar,
        h('div', { class: 'composer-box' },
          textarea,
          h('button', { class: () => `btn primary icon-btn${busy() ? ' ' : ''}`, 'aria-label': 'Send', disabled: () => busy() || !sessionId(), on: { click: () => { void send(textarea.value); textarea.value = ''; textarea.style.height = 'auto'; } } }, icon('send')),
        ),
      ),
    ),
  );
}

function groupMessages(msgs: Msg[]): Msg[][] {
  // Keep an assistant message with the tool messages that follow it, as one visual turn.
  const groups: Msg[][] = [];
  for (const m of msgs) {
    if (m.role === 'tool' && groups.at(-1)?.[0]?.role === 'assistant') groups.at(-1)!.push(m);
    else groups.push([m]);
  }
  return groups;
}

function renderGroup(group: Msg[]): Node {
  const head = group[0]!;
  if (head.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, renderMarkdown(head.content)));
  const tools = group.filter((m) => m.role === 'tool');
  return h('div', { class: 'msg assistant' },
    h('div', { class: 'msg-role' }, 'Feroxes'),
    head.content ? h('div', { class: 'bubble' }, renderMarkdown(head.content)) : false,
    ...(head.toolCalls ?? []).map((c) => renderToolCall(c, tools.find((t) => t.toolName === c.name || true))),
    head.meta?.modelId ? h('div', { class: 'msg-meta' }, h('span', { class: 'mono' }, head.meta.modelId), head.meta.memoryIds?.length ? h('span', {}, `· ${head.meta.memoryIds.length} memories`) : false) : false,
  );
}

function renderToolCall(call: { name: string; args: unknown }, result?: Msg): Node {
  return h('div', { class: 'tool-card' },
    h('div', { class: 'tool-head' }, icon('bolt', 15), h('span', { class: 'tool-name' }, call.name.replace(/__/g, '.')), result?.isError ? h('span', { class: 'pill danger' }, 'error') : false),
    result ? h('div', { class: 'tool-body' }, (result.content ?? '').slice(0, 1200)) : false,
  );
}

function renderApproval(a: Approval, decide: (id: string, approve: boolean, scope?: 'task') => void): Node {
  const device = a.category === 'device_control';
  return h('div', { class: 'approval', style: 'margin-bottom: var(--space-3)' },
    h('div', { class: 'approval-top' }, icon('shield'), h('span', { class: 'approval-title' }, a.preview.title), h('span', { class: 'pill warn' }, a.category)),
    a.preview.body ? h('div', { class: 'approval-body' }, a.preview.body.slice(0, 1000)) : false,
    h('div', { class: 'approval-reason' }, a.policyReason, a.taint?.length ? ` · reads: ${a.taint.map((t) => t.source).join(', ')}` : ''),
    h('div', { class: 'approval-actions' },
      h('button', { class: 'btn primary', on: { click: () => decide(a.id, true) } }, 'Approve'),
      device ? h('button', { class: 'btn', on: { click: () => decide(a.id, true, 'task') } }, 'Allow for this task') : false,
      h('button', { class: 'btn ghost', on: { click: () => decide(a.id, false) } }, 'Deny'),
    ),
  );
}

export { renderMarkdown };
void effect;
void status;
export type { Signal };
