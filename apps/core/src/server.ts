import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { explainRun, HORIZONS, thinkingQuality } from '@feroxes/brain';
import { DAY, errorMessage } from '@feroxes/shared';
import type { Feroxes } from './container.ts';

/**
 * Local API for the Feroxes apps (REST + server-sent events), on 127.0.0.1 only.
 * Every request needs the app token. Host and Origin checks block DNS rebinding and other sites.
 * Node's own HTTP server keeps it dependency-free; Fastify can replace it without changing routes.
 */
export interface ServerOptions {
  port?: number;
  token?: string;
  staticDir?: string;
  allowedOrigins?: string[];
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; url: URL; body: () => Promise<Record<string, unknown>> }) => Promise<unknown>;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function startServer(fx: Feroxes, opts: ServerOptions = {}): Promise<{ server: Server; port: number; token: string; url: string; close: () => Promise<void> }> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, handler });
  };
  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const offEvents = fx.events.subscribe('*', (e) => send(e.topic, e.payload));
  const offNotify = fx.onNotification((n) => send('notification', n));
  const offSystem = fx.system.onChange((c) => send('system', { state: c.state, reason: c.reason }));
  const offMode = fx.power.onChange((c) => send('power', { mode: c.mode }));

  const summary = async () => {
    const self = fx.brain.self.get();
    const budget = (await fx.budget.status()).find((b) => b.budget.id === 'global-day');
    return {
      name: self.identity.name,
      selfVersion: self.version,
      boots: self.identity.bootCount,
      since: self.identity.firstBootAt,
      state: fx.system.state,
      power: fx.power.mode,
      attention: fx.brain.attention.currentMode,
      voice: !!fx.voice,
      providers: fx.catalog.listProviders().map((p) => ({ id: p.id, name: p.name })),
      approvals: (await fx.approvals.pending()).length,
      devicesOnline: fx.hub.online().length,
      spendToday: budget ? { spent: budget.counter.spent, limit: budget.budget.limit } : undefined,
    };
  };

  route('GET', '/api/status', async () => summary());
  route('GET', '/api/today', async () => {
    const snap = await fx.brain.situation.snapshot();
    const briefing = fx.stores.docs.list<{ id: string; text: string }>('briefing').at(-1);
    return {
      status: await summary(),
      briefing: briefing ?? null,
      situation: snap,
      approvals: await fx.approvals.pending(),
      goals: fx.brain.goals.list({ status: ['active', 'proposed'] }),
      forecasts: fx.brain.forecasts.upcoming(14),
      calibration: fx.brain.forecasts.calibration(),
      research: fx.brain.colonies.list().slice(-3),
      notifications: fx.notifications.slice(-8).reverse(),
      hypotheses: fx.brain.hypotheses.open_(),
    };
  });
  route('POST', '/api/briefing', async () => ({ text: await fx.brain.briefing('morning') }));

  route('GET', '/api/sessions', async () => {
    const runs = await fx.agentStore.listRuns({});
    const ids = [...new Set(runs.map((r) => r.sessionId))].reverse();
    const sessions = (await Promise.all(ids.map((id) => fx.agentStore.getSession(id)))).filter((s) => s && s.channel !== 'system');
    return sessions.slice(0, 50);
  });
  route('POST', '/api/sessions', async () => fx.runtime.createSession('web'));
  route('GET', '/api/sessions/:id/messages', async ({ params }) => (await fx.agentStore.messages(params.id!)).map(({ providerState: _p, images, ...m }) => ({ ...m, ...(images ? { images: images.length } : {}) })));
  route('POST', '/api/sessions/:id/messages', async ({ params, body }) => {
    const b = await body();
    const text = String(b.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Empty message.');
    if (text.length > 20_000) throw new HttpError(413, 'Message too long.');
    const tier = ['fast', 'balanced', 'frontier', 'auto'].includes(String(b.tier)) ? (b.tier as 'fast' | 'balanced' | 'frontier' | 'auto') : undefined;
    const { runId, messageId } = await fx.runtime.sendMessage(params.id!, text, tier ? { tier } : {});
    return { runId, messageId };
  });
  route('POST', '/api/runs/:id/cancel', async ({ params }) => (await fx.runtime.cancel(params.id!), { ok: true }));
  route('GET', '/api/runs/:id/explain', async ({ params }) => ({ text: await explainRun({ store: fx.agentStore, audit: fx.audit, memory: fx.memory.store }, params.id!) }));

  route('GET', '/api/approvals', async () => fx.approvals.pending());
  route('POST', '/api/approvals/:id', async ({ params, body }) => {
    const b = await body();
    const r = await fx.runtime.resolveApproval(params.id!, { approve: b.approve === true, ...(b.scope === 'task' ? { scope: 'task' as const } : {}), ...(typeof b.note === 'string' ? { note: b.note } : {}) });
    return { resumed: !!r, runId: r?.runId };
  });

  route('GET', '/api/memories', async ({ url }) => {
    const q = url.searchParams.get('q')?.trim();
    if (q) return (await fx.memory.search({ text: q, limit: 30 })).map((h) => ({ ...h.memory, score: h.score }));
    return fx.memory.store.list({ statuses: ['active'], limit: 200 });
  });
  route('GET', '/api/memories/:id', async ({ params }) => {
    const m = await fx.memory.get(params.id!);
    if (!m) throw new HttpError(404, 'No such memory.');
    return m;
  });
  route('POST', '/api/memories/:id/pin', async ({ params, body }) => (await fx.memory.setPinned(params.id!, (await body()).pinned !== false, 'owner'), { ok: true }));
  route('DELETE', '/api/memories/:id', async ({ params, url }) => (await fx.memory.delete(params.id!, { suppress: url.searchParams.get('suppress') === 'true' }, 'owner'), { ok: true }));
  route('GET', '/api/palace', async () => ({ rooms: fx.brain.palace.rooms(), layout: Object.fromEntries(Object.entries(await fx.brain.palace.layout()).map(([k, v]) => [k, v.length])) }));

  route('GET', '/api/goals', async () => ({ horizons: HORIZONS, goals: fx.brain.goals.list() }));
  route('POST', '/api/goals', async ({ body }) => {
    const b = await body();
    const horizon = HORIZONS.includes(b.horizon as never) ? (b.horizon as (typeof HORIZONS)[number]) : 'week';
    return fx.brain.goals.create({ title: String(b.title ?? '').slice(0, 200), horizon, ...(typeof b.priority === 'number' ? { priority: b.priority } : {}) }, 'owner');
  });
  route('POST', '/api/goals/:id', async ({ params, body }) => {
    const b = await body();
    if (typeof b.status === 'string') return fx.brain.goals.setStatus(params.id!, b.status as never, 'owner');
    if (typeof b.autonomy === 'string') return fx.brain.goals.setAutonomy(params.id!, b.autonomy as never, 'owner');
    throw new HttpError(400, 'Nothing to change.');
  });

  route('GET', '/api/mind', async () => ({
    self: fx.brain.self.get(),
    versions: fx.brain.self.history().map((v) => ({ version: v.version, at: v.updatedAt, by: v.updatedBy, reason: v.reason })),
    proposals: fx.brain.self.proposals(),
    calibration: fx.brain.forecasts.calibration(),
    forecasts: fx.brain.forecasts.list().slice(-30).reverse(),
    beliefs: fx.brain.causal.beliefs().sort((a, b) => b.confidence - a.confidence).slice(0, 30),
    chains: fx.brain.causal.chains(),
    hypotheses: fx.brain.hypotheses.open_(),
    research: fx.brain.colonies.list().reverse(),
    skills: fx.brain.skills.list(),
    improvements: fx.brain.reflection.improvements(),
    reflections: fx.brain.reflection.logs().slice(-14).reverse(),
    quality: await thinkingQuality(fx.agentStore, Date.now() - 7 * DAY),
    growth: fx.brain.reflection.evolutionReport(7),
    observation: fx.brain.observation.summary(7),
  }));
  route('POST', '/api/mind/proposals/:id', async ({ params, body }) => (fx.brain.self.resolveProposal(params.id!, (await body()).accept === true), { ok: true }));
  route('POST', '/api/forecasts/:id', async ({ params, body }) => fx.brain.forecasts.resolve(params.id!, (await body()).happened === true, 'owner'));
  route('POST', '/api/attention', async ({ body }) => {
    const mode = String((await body()).mode);
    if (!['ambient', 'focus', 'silent', 'proactive'].includes(mode)) throw new HttpError(400, 'Unknown mode.');
    fx.brain.attention.setMode(mode as never);
    send('attention', { mode });
    return { mode };
  });

  route('GET', '/api/devices', async () => fx.hub.devices());
  route('POST', '/api/devices/pair', async () => fx.hub.createPairingCode());
  route('DELETE', '/api/devices/:id', async ({ params }) => (await fx.hub.revoke(params.id!), { ok: true }));

  route('GET', '/api/usage', async () => ({ byModel: await fx.ledger.summarize({ from: Date.now() - 30 * DAY }, 'modelId'), budgets: await fx.budget.status(), power: fx.power.mode }));
  route('POST', '/api/system/stop', async ({ body }) => (await fx.system.stop('owner', String((await body()).reason ?? 'app')), summary()));
  route('POST', '/api/system/resume', async () => (await fx.system.resume('owner', 'app'), summary()));
  route('POST', '/api/system/power', async ({ body }) => {
    const mode = String((await body()).mode);
    if (!['normal', 'economy', 'background_paused'].includes(mode)) throw new HttpError(400, 'Unknown power mode.');
    fx.power.set(mode as never, 'owner', 'app');
    return summary();
  });

  route('GET', '/api/events', async ({ req, res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify(await summary())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return STREAMING;
  });

  const origins = new Set(opts.allowedOrigins ?? ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = req.headers.origin;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    try {
      if (host !== '127.0.0.1' && host !== 'localhost') throw new HttpError(421, 'Wrong host.');
      const sameOrigin = origin === `http://${req.headers.host}`;
      if (origin && !sameOrigin && !origins.has(origin)) throw new HttpError(403, 'Origin not allowed.');
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
      }
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,DELETE', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' });
        return void res.end();
      }
      if (!url.pathname.startsWith('/api/')) return void (await serveStatic(res, url.pathname, opts.staticDir));

      const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expected = Buffer.from(token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Missing or wrong app token.');

      const match = routes.map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null })).find((x) => x.m);
      if (!match?.m) throw new HttpError(404, 'Not found.');
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1]!)]));
      const result = await match.r.handler({ req, res, params, url, body: () => readBody(req) });
      if (result === STREAMING) return;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result ?? null));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error as { code?: string }).code === 'not_found' ? 404 : (error as { code?: string }).code === 'owner_only' ? 403 : 400;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: errorMessage(error) }));
    }
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen); // e.g. EADDRINUSE: report it instead of crashing on an unhandled 'error'
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    offEvents();
    offNotify();
    offSystem();
    offMode();
    throw error;
  }
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      offEvents();
      offNotify();
      offSystem();
      offMode();
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const STREAMING = Symbol('streaming');

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'Body too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

async function serveStatic(res: ServerResponse, pathname: string, dir?: string) {
  if (!dir) throw new HttpError(404, 'Not found.');
  const root = resolve(dir);
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = join(root, rel || 'index.html');
  if (!file.startsWith(root)) throw new HttpError(403, 'Forbidden.');
  const info = await stat(file).catch(() => undefined);
  if (!info || info.isDirectory()) file = join(root, 'index.html'); // single-page app fallback
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:* ; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  });
  res.end(body);
}
