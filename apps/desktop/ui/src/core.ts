/**
 * A tiny fine-grained reactive layer (signals + effects + DOM helpers). Updates touch only the
 * nodes that depend on changed state, so there are no full re-renders, flicker or layout jumps.
 */
type Effect = { run: () => void; deps: Set<Set<Effect>>; cleanup?: () => void };
let active: Effect | null = null;
let batchDepth = 0;
const queue = new Set<Effect>();

export interface Signal<T> {
  (): T;
  set(v: T): void;
  update(fn: (v: T) => T): void;
  peek(): T;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<Effect>();
  const read = (() => {
    if (active) {
      subs.add(active);
      active.deps.add(subs);
    }
    return value;
  }) as Signal<T>;
  read.peek = () => value;
  read.set = (v: T) => {
    if (Object.is(v, value)) return;
    value = v;
    for (const e of [...subs]) queue.add(e);
    if (batchDepth === 0) flush();
  };
  read.update = (fn) => read.set(fn(value));
  return read;
}

function flush() {
  while (queue.size) {
    const list = [...queue];
    queue.clear();
    for (const e of list) runEffect(e);
  }
}

function runEffect(e: Effect) {
  for (const d of e.deps) d.delete(e);
  e.deps.clear();
  e.cleanup?.();
  const prev = active;
  active = e;
  try {
    e.run();
  } finally {
    active = prev;
  }
}

export function effect(fn: () => void | (() => void)): () => void {
  const e: Effect = {
    deps: new Set(),
    run: () => {
      const c = fn();
      e.cleanup = typeof c === 'function' ? c : undefined;
    },
  };
  runEffect(e);
  return () => {
    for (const d of e.deps) d.delete(e);
    e.cleanup?.();
  };
}

export function computed<T>(fn: () => T): () => T {
  const s = signal<T>(undefined as T);
  effect(() => s.set(fn()));
  return s;
}

export function batch(fn: () => void) {
  batchDepth++;
  try {
    fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

// ---------------------------------------------------------------- DOM

type Child = Node | string | number | false | null | undefined | (() => unknown) | Child[];
type Props = Record<string, unknown> & { class?: string | (() => string); on?: Record<string, (e: never) => void>; style?: string | (() => string) };

/** h('div', { class: 'card', on: { click } }, children…). Function props and children are reactive. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
      else if (k === 'ref') (v as (e: HTMLElement) => void)(el);
      else if (typeof v === 'function') effect(() => setProp(el, k, (v as () => unknown)()));
      else setProp(el, k, v);
    }
  }
  append(el, children);
  return el;
}

function setProp(el: HTMLElement, k: string, v: unknown) {
  if (k === 'class') el.className = String(v ?? '');
  else if (k === 'style') el.setAttribute('style', String(v ?? ''));
  else if (k in el && !k.startsWith('aria-') && !k.startsWith('data-')) (el as unknown as Record<string, unknown>)[k] = v;
  else if (v === false || v == null) el.removeAttribute(k);
  else el.setAttribute(k, v === true ? '' : String(v));
}

export function append(parent: Node, children: Child[]) {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c === false || c == null) continue;
    if (typeof c === 'function') {
      const anchor = document.createComment('');
      parent.appendChild(anchor);
      let nodes: Node[] = [];
      effect(() => {
        const v = c();
        const next = toNodes(v);
        for (const n of nodes) n.parentNode?.removeChild(n);
        const frag = document.createDocumentFragment();
        for (const n of next) frag.appendChild(n);
        anchor.parentNode?.insertBefore(frag, anchor.nextSibling);
        nodes = next;
      });
    } else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function toNodes(v: unknown): Node[] {
  if (v === false || v == null) return [];
  if (Array.isArray(v)) return v.flatMap(toNodes);
  if (v instanceof Node) return [v];
  return [document.createTextNode(String(v))];
}

/**
 * Keyed list: existing rows are kept and moved instead of rebuilt, so streaming updates,
 * animations and focus are not disturbed.
 */
export function list<T>(items: () => T[], key: (item: T) => string, render: (item: () => T) => Node): Node {
  const container = document.createDocumentFragment();
  const anchor = document.createComment('list');
  container.appendChild(anchor);
  let rows = new Map<string, { node: Node; item: Signal<T> }>();
  effect(() => {
    const next = new Map<string, { node: Node; item: Signal<T> }>();
    const parent = anchor.parentNode;
    let cursor: Node = anchor;
    for (const it of items()) {
      const k = key(it);
      let row = rows.get(k);
      if (row) row.item.set(it);
      else {
        const item = signal(it);
        row = { node: render(item), item };
      }
      next.set(k, row);
      if (parent && cursor.nextSibling !== row.node) parent.insertBefore(row.node, cursor.nextSibling);
      cursor = row.node;
    }
    for (const [k, row] of rows) if (!next.has(k)) row.node.parentNode?.removeChild(row.node);
    rows = next;
  });
  return container;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const usd = (nanos: number) => {
  const v = nanos / 1e9;
  return v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : v > 0 ? `$${v.toFixed(4)}` : '$0';
};

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Runs a DOM change inside a View Transition when supported (cross-fade between screens). */
export function transition(fn: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (d.startViewTransition && !prefersReducedMotion()) d.startViewTransition(fn);
  else fn();
}
