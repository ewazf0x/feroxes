import { createHash, randomBytes } from 'node:crypto';
import type { ApprovalPreview, AuditLog, RiskCategory, TaintSource } from '@feroxes/policy';
import { type Clock, type Logger, noopLogger, scrubSecrets, systemClock, uuidv7 } from '@feroxes/shared';
import { type AnyTool, defineTool, z } from '@feroxes/tools';

/**
 * Integrations framework. A connector is a declarative description of an official API:
 * how to authenticate (OAuth 2.0 authorization code + PKCE, or a token the owner pastes), which
 * capabilities it offers (each with the scopes it needs and the actions it enables), and the
 * actions themselves. The manager handles everything else, identically for every connector:
 * connecting, sealed credential storage, token refresh, revocation, health checks, per-account
 * capability switches, audit entries, and exposing actions as tools behind the policy gate.
 *
 * Security rules enforced here, not by each connector:
 * - Credentials live only in the vault (SecretStore). Connection records hold no secrets.
 * - Tools never take credentials as arguments; tool output and errors are scrubbed of every
 *   credential value used for the call before they reach the model, the UI or the audit log.
 * - Content written by other people (messages, emails, files, comments) is returned inside an
 *   <untrusted> block and taints the run, so later outward actions need approval.
 * - A disabled capability or an unhealthy connection blocks the tool before any request is sent.
 */

// ---------------------------------------------------------------- types

export interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  help?: string;
  optional?: boolean;
}

export interface OAuthSpec {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** S256 PKCE (RFC 7636). */
  pkce: boolean;
  /** How client credentials are sent to the token endpoint. */
  clientAuth: 'body' | 'basic';
  scopeSeparator?: string;
  /** Scopes always requested (e.g. identity), on top of the enabled capabilities' scopes. */
  baseScopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
}

export type AuthSpec =
  | { kind: 'oauth2'; oauth: OAuthSpec; appFields: Field[] }
  | { kind: 'token'; fields: Field[] }
  | { kind: 'none' };

export interface Capability {
  id: string;
  label: string;
  description: string;
  scopes?: string[];
  /** Turned on when a new account is connected. Sensitive capabilities default to off. */
  default: boolean;
}

export interface Identity {
  id: string;
  name: string;
}

export interface Secrets {
  [key: string]: string | undefined;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
  /** Return the response text instead of parsing JSON. */
  text?: boolean;
}

export interface ApiClient {
  request<T = unknown>(method: string, pathOrUrl: string, opts?: RequestOptions): Promise<T>;
}

export interface ActionContext {
  api: ApiClient;
  connection: Connection;
  secrets: Secrets;
  signal: AbortSignal;
  /** Persisted, non-secret per-connection state (e.g. a Telegram update offset). */
  state: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
}

export interface ActionResult {
  text: string;
  data?: unknown;
}

export interface Action {
  /** Full tool name: "<connector>.<verb>" (lowercase, dots/underscores only). */
  name: string;
  capability: string;
  category: RiskCategory;
  description: string;
  input: z.ZodObject;
  /** Set when the result contains content written by other people. */
  untrusted?: TaintSource['kind'];
  preview?(input: Record<string, unknown>): ApprovalPreview;
  /** Risk that depends on the arguments (e.g. an event with attendees sends invitations). */
  riskFor?(input: Record<string, unknown>): RiskCategory;
  /** Safe to run in a live check against a real account (read-only, cheap). */
  liveSafe?: boolean;
  run(input: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult>;
}

export interface Connector {
  id: string;
  name: string;
  category: 'social' | 'productivity' | 'developer';
  docsUrl: string;
  auth: AuthSpec;
  capabilities: Capability[];
  /** What the official API can't do, or the conditions it imposes. Shown to the owner. */
  limitations: string[];
  setupSteps: string[];
  /** Base URL for relative request paths. */
  baseUrl(secrets: Secrets): string;
  /** Adds authentication to a request. */
  sign(req: { url: URL; headers: Record<string, string> }, secrets: Secrets): void;
  whoami(api: ApiClient, secrets: Secrets): Promise<Identity>;
  actions: Action[];
  /** Optional: turns a short-lived token response into what we store (e.g. Instagram long-lived). */
  afterToken?(tokens: TokenSet, app: Secrets, fetchImpl: typeof fetch): Promise<TokenSet>;
  /** Optional custom refresh (non-standard providers). */
  refresh?(secrets: Secrets, fetchImpl: typeof fetch): Promise<TokenSet>;
  /** Optional custom revocation; the default uses oauth.revokeUrl (RFC 7009). */
  revoke?(secrets: Secrets, app: Secrets, fetchImpl: typeof fetch): Promise<void>;
  /** Classifies provider-specific error bodies (e.g. Slack returns 200 with ok:false). */
  checkBody?(body: unknown): ConnectorError | undefined;
  defaultHeaders?: Record<string, string>;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [k: string]: unknown;
}

export type ConnectionStatus = 'connected' | 'needs_reauth' | 'error' | 'rate_limited';

export interface Connection {
  id: string;
  connectorId: string;
  accountId: string;
  accountName: string;
  status: ConnectionStatus;
  enabledCapabilities: string[];
  grantedScopes?: string[];
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
  lastOkAt?: number;
  lastError?: string;
  state?: Record<string, unknown>;
}

export type ConnectorErrorCode = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'bad_request' | 'conflict' | 'server' | 'network' | 'timeout' | 'not_connected' | 'capability_off' | 'setup';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly status?: number;
  readonly retryAfterSec?: number;
  constructor(code: ConnectorErrorCode, message: string, extra: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
  }
}

/** Where sealed credentials live (apps/core SecretStore satisfies this). */
export interface SecretVault {
  put(name: string, value: string): void;
  get(name: string): string | undefined;
  delete(name: string): void;
  deletePrefix(prefix: string): number;
}

export interface ConnectionDocs {
  put<T extends { id: string }>(kind: string, doc: T, updatedAt?: number): void;
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string): T[];
  delete(kind: string, id: string): void;
}

// ---------------------------------------------------------------- HTTP

const ERR_BY_STATUS: Record<number, ConnectorErrorCode> = { 400: 'bad_request', 401: 'auth', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'bad_request', 429: 'rate_limited' };

function providerMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 300) : undefined;
  const b = body as Record<string, unknown>;
  const e = b.error as Record<string, unknown> | string | undefined;
  return (
    (typeof b.message === 'string' && b.message) ||
    (typeof e === 'string' && (typeof b.error_description === 'string' ? `${e}: ${b.error_description}` : e)) ||
    (e && typeof e === 'object' && typeof e.message === 'string' && e.message) ||
    (typeof b.description === 'string' && b.description) ||
    undefined
  );
}

export function createApiClient(o: { connector: Connector; secrets: () => Secrets; fetch: typeof fetch; signal?: AbortSignal; timeoutMs?: number; onAuthError?: () => Promise<boolean> }): ApiClient {
  const attempt = async <T>(method: string, pathOrUrl: string, opts: RequestOptions, retried: boolean): Promise<T> => {
    const secrets = o.secrets();
    const known = Object.values(secrets).filter((v): v is string => typeof v === 'string');
    const url = new URL(/^https?:\/\//.test(pathOrUrl) ? pathOrUrl : o.connector.baseUrl(secrets).replace(/\/$/, '') + (pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Feroxes/0.1 (personal assistant)', ...o.connector.defaultHeaders, ...opts.headers };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) body = opts.body;
    o.connector.sign({ url, headers }, secrets);
    const signals = [AbortSignal.timeout(o.timeoutMs ?? 30_000), ...(o.signal ? [o.signal] : [])];
    let res: Response;
    try {
      res = await o.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.any(signals), redirect: 'follow' });
    } catch (error) {
      const aborted = o.signal?.aborted;
      throw new ConnectorError(aborted ? 'timeout' : (error as Error).name === 'TimeoutError' ? 'timeout' : 'network', aborted ? 'Cancelled.' : scrubSecrets(`Couldn't reach ${o.connector.name} (${(error as Error).message}).`, known));
    }
    const raw = await res.text();
    let parsed: unknown = raw;
    if (!opts.text && raw && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    if (!res.ok) {
      if (res.status === 401 && !retried && o.onAuthError && (await o.onAuthError())) return attempt<T>(method, pathOrUrl, opts, true);
      const code = ERR_BY_STATUS[res.status] ?? (res.status >= 500 ? 'server' : 'bad_request');
      const retryAfter = Number(res.headers.get('retry-after') ?? '') || undefined;
      const detail = providerMessage(parsed);
      throw new ConnectorError(code, scrubSecrets(`${o.connector.name} returned ${res.status}${detail ? `: ${detail}` : ''}`, known), { status: res.status, ...(retryAfter ? { retryAfterSec: retryAfter } : {}) });
    }
    const bodyError = o.connector.checkBody?.(parsed);
    if (bodyError) {
      if (bodyError.code === 'auth' && !retried && o.onAuthError && (await o.onAuthError())) return attempt<T>(method, pathOrUrl, opts, true);
      throw new ConnectorError(bodyError.code, scrubSecrets(bodyError.message, known));
    }
    return parsed as T;
  };
  return { request: (method, pathOrUrl, opts = {}) => attempt(method, pathOrUrl, opts, false) };
}

// ---------------------------------------------------------------- OAuth helpers

export const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function tokenRequest(fetchImpl: typeof fetch, spec: OAuthSpec, app: Secrets, form: Record<string, string>): Promise<TokenSet> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Feroxes/0.1 (personal assistant)' };
  const body = new URLSearchParams(form);
  if (spec.clientAuth === 'basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(app.client_id ?? '')}:${encodeURIComponent(app.client_secret ?? '')}`).toString('base64')}`;
  else {
    body.set('client_id', app.client_id ?? '');
    if (app.client_secret) body.set('client_secret', app.client_secret);
  }
  const res = await fetchImpl(spec.tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = Object.fromEntries(new URLSearchParams(text)); // GitHub can answer form-encoded
  }
  const known = [app.client_secret ?? '', form.code ?? '', form.refresh_token ?? '', form.code_verifier ?? ''];
  if (!res.ok || json.error || typeof json.access_token !== 'string') {
    const err = String(json.error ?? res.status);
    throw new ConnectorError(err === 'invalid_grant' ? 'auth' : res.status >= 500 ? 'server' : 'bad_request', scrubSecrets(`Token request failed: ${err}${json.error_description ? ` (${String(json.error_description)})` : ''}`, known));
  }
  return json as TokenSet;
}

// ---------------------------------------------------------------- manager

interface Pending {
  connectorId: string;
  verifier: string;
  capabilities: string[];
  redirectUri: string;
  expiresAt: number;
}

export interface ManagerOptions {
  connectors: Connector[];
  docs: ConnectionDocs;
  vault: SecretVault;
  audit?: AuditLog;
  fetch?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
  redirectUri: () => string;
  /** Opens a URL in the owner's browser (the Core runs on their PC). */
  openBrowser?: (url: string) => void;
}

export interface ConnectorSummary {
  id: string;
  name: string;
  category: Connector['category'];
  docsUrl: string;
  authKind: AuthSpec['kind'];
  fields: Field[];
  appFields: Field[];
  appConfigured: boolean;
  redirectUri?: string;
  capabilities: Capability[];
  limitations: string[];
  setupSteps: string[];
  actions: { name: string; capability: string; category: RiskCategory; description: string }[];
  connections: Connection[];
}

const KIND = 'connection';

export class ConnectorManager {
  private readonly o: Required<Omit<ManagerOptions, 'audit' | 'openBrowser'>> & Pick<ManagerOptions, 'audit' | 'openBrowser'>;
  private readonly byId: Map<string, Connector>;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(e: { connectionId?: string; connectorId: string; event: string }) => void>();
  private readonly refreshing = new Map<string, Promise<boolean>>();

  constructor(options: ManagerOptions) {
    this.o = { fetch: globalThis.fetch.bind(globalThis), clock: systemClock, logger: noopLogger, ...options };
    this.byId = new Map(options.connectors.map((c) => [c.id, c]));
    for (const c of options.connectors) for (const a of c.actions) if (!a.name.startsWith(`${c.id}.`)) throw new Error(`action ${a.name} must start with "${c.id}."`);
  }

  onChange(cb: (e: { connectionId?: string; connectorId: string; event: string }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  connector(id: string): Connector {
    const c = this.byId.get(id);
    if (!c) throw new ConnectorError('not_found', `Unknown integration "${id}".`);
    return c;
  }

  connections(connectorId?: string): Connection[] {
    return this.o.docs.list<Connection>(KIND).filter((c) => !connectorId || c.connectorId === connectorId);
  }

  connection(id: string): Connection {
    const c = this.o.docs.get<Connection>(KIND, id);
    if (!c) throw new ConnectorError('not_found', 'No such connected account.');
    return c;
  }

  summaries(): ConnectorSummary[] {
    return [...this.byId.values()].map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      docsUrl: c.docsUrl,
      authKind: c.auth.kind,
      fields: c.auth.kind === 'token' ? c.auth.fields : [],
      appFields: c.auth.kind === 'oauth2' ? c.auth.appFields : [],
      appConfigured: c.auth.kind !== 'oauth2' || !!this.o.vault.get(`connector-app:${c.id}:client_id`),
      ...(c.auth.kind === 'oauth2' ? { redirectUri: this.o.redirectUri() } : {}),
      capabilities: c.capabilities,
      limitations: c.limitations,
      setupSteps: c.setupSteps,
      actions: c.actions.map((a) => ({ name: a.name, capability: a.capability, category: a.category, description: a.description })),
      connections: this.connections(c.id),
    }));
  }

  /** OAuth apps are registered by the owner (Feroxes is self-hosted); their client id/secret are sealed. */
  async setAppCredentials(connectorId: string, fields: Record<string, string>): Promise<void> {
    const c = this.connector(connectorId);
    if (c.auth.kind !== 'oauth2') throw new ConnectorError('setup', `${c.name} doesn't use an OAuth app.`);
    for (const f of c.auth.appFields) {
      const v = fields[f.key]?.trim();
      if (!v && !f.optional) throw new ConnectorError('setup', `${f.label} is required.`);
      if (v) this.o.vault.put(`connector-app:${c.id}:${f.key}`, v);
    }
    await this.auditEvent(c.id, undefined, 'app_configured', `Saved the OAuth app for ${c.name}`, 'success');
    this.emit({ connectorId: c.id, event: 'app_configured' });
  }

  private app(c: Connector): Secrets {
    if (c.auth.kind !== 'oauth2') return {};
    return Object.fromEntries(c.auth.appFields.map((f) => [f.key, this.o.vault.get(`connector-app:${c.id}:${f.key}`)]));
  }

  private scopesFor(c: Connector, caps: string[]): string[] {
    const base = c.auth.kind === 'oauth2' ? (c.auth.oauth.baseScopes ?? []) : [];
    return [...new Set([...base, ...c.capabilities.filter((k) => caps.includes(k.id)).flatMap((k) => k.scopes ?? [])])];
  }

  private validCaps(c: Connector, caps?: string[]): string[] {
    const ids = c.capabilities.map((k) => k.id);
    const chosen = caps ?? c.capabilities.filter((k) => k.default).map((k) => k.id);
    const bad = chosen.filter((k) => !ids.includes(k));
    if (bad.length) throw new ConnectorError('bad_request', `Unknown capability: ${bad.join(', ')}.`);
    return chosen;
  }

  /** Starts an OAuth authorization (code flow with PKCE and a single-use state). */
  beginOAuth(connectorId: string, capabilities?: string[]): { authorizeUrl: string; state: string } {
    const c = this.connector(connectorId);
    if (c.auth.kind !== 'oauth2') throw new ConnectorError('setup', `${c.name} connects with a token, not OAuth.`);
    const app = this.app(c);
    if (!app.client_id) throw new ConnectorError('setup', `Add your ${c.name} OAuth app (client ID${c.auth.appFields.some((f) => f.key === 'client_secret' && !f.optional) ? ' and secret' : ''}) first.`);
    const caps = this.validCaps(c, capabilities);
    const now = this.o.clock.now();
    for (const [k, p] of this.pending) if (p.expiresAt < now) this.pending.delete(k);
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkcePair();
    const redirectUri = this.o.redirectUri();
    this.pending.set(state, { connectorId, verifier, capabilities: caps, redirectUri, expiresAt: now + 10 * 60_000 });
    const url = new URL(c.auth.oauth.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', app.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    const scopes = this.scopesFor(c, caps);
    if (scopes.length) url.searchParams.set('scope', scopes.join(c.auth.oauth.scopeSeparator ?? ' '));
    url.searchParams.set('state', state);
    if (c.auth.oauth.pkce) {
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [k, v] of Object.entries(c.auth.oauth.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
    this.o.openBrowser?.(url.toString());
    return { authorizeUrl: url.toString(), state };
  }

  /** The loopback redirect: validates state, exchanges the code, verifies identity, stores tokens. */
  async completeOAuth(params: { state?: string | null; code?: string | null; error?: string | null; error_description?: string | null }): Promise<Connection> {
    const pending = params.state ? this.pending.get(params.state) : undefined;
    if (!pending || pending.expiresAt < this.o.clock.now()) throw new ConnectorError('auth', 'This sign-in link is invalid or expired. Start again from Integrations.');
    this.pending.delete(params.state!); // single use
    const c = this.connector(pending.connectorId);
    if (params.error) {
      await this.auditEvent(c.id, undefined, 'connect', `Sign-in to ${c.name} was cancelled or refused (${params.error})`, 'failure');
      throw new ConnectorError('auth', `${c.name} sign-in was not completed: ${scrubSecrets(params.error_description ?? params.error)}.`);
    }
    if (!params.code || c.auth.kind !== 'oauth2') throw new ConnectorError('auth', 'The sign-in response had no authorization code.');
    const app = this.app(c);
    let tokens = await tokenRequest(this.o.fetch, c.auth.oauth, app, { grant_type: 'authorization_code', code: params.code, redirect_uri: pending.redirectUri, ...(c.auth.oauth.pkce ? { code_verifier: pending.verifier } : {}) });
    if (c.afterToken) tokens = await c.afterToken(tokens, app, this.o.fetch);
    const secrets: Secrets = { access_token: tokens.access_token, ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}) };
    return this.finishConnect(c, secrets, pending.capabilities, tokens);
  }

  /** Connects a token-based integration (bot tokens, personal access tokens, system-user tokens). */
  async connectWithToken(connectorId: string, fields: Record<string, string>, capabilities?: string[]): Promise<Connection> {
    const c = this.connector(connectorId);
    if (c.auth.kind === 'oauth2') throw new ConnectorError('setup', `${c.name} connects with OAuth sign-in.`);
    const secrets: Secrets = {};
    if (c.auth.kind === 'token')
      for (const f of c.auth.fields) {
        const v = fields[f.key]?.trim();
        if (!v && !f.optional) throw new ConnectorError('setup', `${f.label} is required.`);
        if (v) secrets[f.key] = v;
      }
    return this.finishConnect(c, secrets, this.validCaps(c, capabilities));
  }

  private async finishConnect(c: Connector, secrets: Secrets, caps: string[], tokens?: TokenSet): Promise<Connection> {
    const api = createApiClient({ connector: c, secrets: () => secrets, fetch: this.o.fetch });
    let who: Identity;
    try {
      who = await c.whoami(api, secrets);
    } catch (error) {
      await this.auditEvent(c.id, undefined, 'connect', `Connecting ${c.name} failed: ${(error as Error).message}`, 'failure');
      throw error;
    }
    const now = this.o.clock.now();
    const existing = this.connections(c.id).find((x) => x.accountId === who.id);
    const conn: Connection = {
      id: existing?.id ?? uuidv7(now),
      connectorId: c.id,
      accountId: who.id,
      accountName: who.name,
      status: 'connected',
      enabledCapabilities: caps,
      ...(tokens?.scope ? { grantedScopes: tokens.scope.split(/[ ,]+/).filter(Boolean) } : {}),
      ...(tokens?.expires_in ? { expiresAt: now + Number(tokens.expires_in) * 1000 } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: now,
      lastOkAt: now,
      ...(existing?.state ? { state: existing.state } : {}),
    };
    this.o.vault.deletePrefix(`connector:${conn.id}:`);
    for (const [k, v] of Object.entries(secrets)) if (v) this.o.vault.put(`connector:${conn.id}:${k}`, v);
    this.o.docs.put(KIND, conn);
    await this.auditEvent(c.id, conn.id, 'connect', `Connected ${c.name} account ${who.name} (${caps.join(', ') || 'no capabilities'})`, 'success', { capabilities: caps, scopes: conn.grantedScopes });
    this.emit({ connectorId: c.id, connectionId: conn.id, event: 'connected' });
    return conn;
  }

  private secretsOf(conn: Connection): Secrets {
    const c = this.connector(conn.connectorId);
    const keys = c.auth.kind === 'token' ? c.auth.fields.map((f) => f.key) : c.auth.kind === 'oauth2' ? ['access_token', 'refresh_token'] : [];
    return Object.fromEntries(keys.map((k) => [k, this.o.vault.get(`connector:${conn.id}:${k}`)]));
  }

  /** Refreshes an OAuth access token (rotating refresh tokens are stored). False when it can't. */
  private refresh(conn: Connection): Promise<boolean> {
    const running = this.refreshing.get(conn.id);
    if (running) return running;
    const job = (async () => {
      const c = this.connector(conn.connectorId);
      const s = this.secretsOf(conn);
      try {
        let tokens: TokenSet;
        if (c.refresh) tokens = await c.refresh(s, this.o.fetch);
        else if (c.auth.kind === 'oauth2' && s.refresh_token) tokens = await tokenRequest(this.o.fetch, c.auth.oauth, this.app(c), { grant_type: 'refresh_token', refresh_token: s.refresh_token });
        else return false;
        this.o.vault.put(`connector:${conn.id}:access_token`, tokens.access_token);
        if (tokens.refresh_token) this.o.vault.put(`connector:${conn.id}:refresh_token`, tokens.refresh_token);
        const now = this.o.clock.now();
        this.update(conn.id, { status: 'connected', updatedAt: now, ...(tokens.expires_in ? { expiresAt: now + Number(tokens.expires_in) * 1000 } : {}) });
        await this.auditEvent(c.id, conn.id, 'token_refresh', `Refreshed the ${c.name} access token for ${conn.accountName}`, 'success');
        return true;
      } catch (error) {
        const reauth = error instanceof ConnectorError && error.code === 'auth';
        this.update(conn.id, { status: reauth ? 'needs_reauth' : 'error', lastError: (error as Error).message, updatedAt: this.o.clock.now() });
        await this.auditEvent(c.id, conn.id, 'token_refresh', `Refreshing the ${c.name} token for ${conn.accountName} failed: ${(error as Error).message}`, 'failure');
        this.emit({ connectorId: c.id, connectionId: conn.id, event: 'status' });
        return false;
      } finally {
        this.refreshing.delete(conn.id);
      }
    })();
    this.refreshing.set(conn.id, job);
    return job;
  }

  /** An API client for a connection, refreshing tokens before expiry and once on a 401. */
  async client(conn: Connection, signal?: AbortSignal): Promise<{ api: ApiClient; secrets: () => Secrets }> {
    if (conn.expiresAt && conn.expiresAt - 60_000 < this.o.clock.now()) await this.refresh(conn);
    const c = this.connector(conn.connectorId);
    const secrets = () => this.secretsOf(this.connection(conn.id));
    const api = createApiClient({ connector: c, secrets, fetch: this.o.fetch, ...(signal ? { signal } : {}), onAuthError: () => this.refresh(this.connection(conn.id)) });
    return { api, secrets };
  }

  /** Health check: verifies the credentials with a cheap identity call. */
  async check(connectionId: string): Promise<Connection> {
    const conn = this.connection(connectionId);
    const c = this.connector(conn.connectorId);
    const before = conn.status;
    const now = this.o.clock.now();
    // Long-lived tokens without a refresh token (Instagram) are renewed about once a week.
    if (c.refresh && before === 'connected' && now - Number(conn.state?.refreshedAt ?? conn.createdAt) > 7 * 864e5) {
      if (await this.refresh(conn)) this.update(conn.id, { state: { ...(this.connection(conn.id).state ?? {}), refreshedAt: now } });
    }
    try {
      const { api, secrets } = await this.client(conn);
      await c.whoami(api, secrets());
      this.update(conn.id, { status: 'connected', lastCheckedAt: now, lastOkAt: now, updatedAt: now });
      if (before !== 'connected') await this.auditEvent(c.id, conn.id, 'health', `${c.name} account ${conn.accountName} is healthy again`, 'success');
    } catch (error) {
      const e = error as ConnectorError;
      const status: ConnectionStatus = e.code === 'auth' ? 'needs_reauth' : e.code === 'rate_limited' ? 'rate_limited' : 'error';
      this.update(conn.id, { status, lastError: e.message, lastCheckedAt: now, updatedAt: now });
      if (before !== status) await this.auditEvent(c.id, conn.id, 'health', `${c.name} account ${conn.accountName}: ${status} (${e.message})`, 'failure');
    }
    this.emit({ connectorId: c.id, connectionId: conn.id, event: 'status' });
    return this.connection(conn.id);
  }

  async setCapabilities(connectionId: string, capabilities: string[]): Promise<Connection> {
    const conn = this.connection(connectionId);
    const c = this.connector(conn.connectorId);
    const caps = this.validCaps(c, capabilities);
    const needs = c.auth.kind === 'oauth2' && conn.grantedScopes ? this.scopesFor(c, caps).filter((s) => !conn.grantedScopes!.includes(s)) : [];
    this.update(conn.id, { enabledCapabilities: caps, updatedAt: this.o.clock.now() });
    await this.auditEvent(c.id, conn.id, 'permissions', `Changed what Feroxes may do with ${c.name} (${conn.accountName}): ${caps.join(', ') || 'nothing'}`, 'success', { capabilities: caps, ...(needs.length ? { missingScopes: needs } : {}) });
    this.emit({ connectorId: c.id, connectionId: conn.id, event: 'permissions' });
    return this.connection(conn.id);
  }

  /** Revokes the grant at the provider when it supports it, then deletes every stored credential. */
  async disconnect(connectionId: string): Promise<{ revoked: boolean }> {
    const conn = this.connection(connectionId);
    const c = this.connector(conn.connectorId);
    const s = this.secretsOf(conn);
    let revoked = false;
    try {
      if (c.revoke) {
        await c.revoke(s, this.app(c), this.o.fetch);
        revoked = true;
      } else if (c.auth.kind === 'oauth2' && c.auth.oauth.revokeUrl && (s.refresh_token || s.access_token)) {
        const app = this.app(c);
        const body = new URLSearchParams({ token: s.refresh_token ?? s.access_token!, client_id: app.client_id ?? '', ...(app.client_secret ? { client_secret: app.client_secret } : {}) });
        const res = await this.o.fetch(c.auth.oauth.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
        revoked = res.ok;
      }
    } catch (error) {
      this.o.logger.warn('revocation failed', { connector: c.id, error: String(error) });
    }
    this.o.vault.deletePrefix(`connector:${conn.id}:`);
    this.o.docs.delete(KIND, conn.id);
    await this.auditEvent(c.id, conn.id, 'disconnect', `Disconnected ${c.name} account ${conn.accountName}${revoked ? ' and revoked access at the provider' : ''}`, 'success', { revoked });
    this.emit({ connectorId: c.id, connectionId: conn.id, event: 'disconnected' });
    return { revoked };
  }

  /** Tool names whose actions are currently usable (for the agent's toolsets). */
  toolsets(): string[] {
    return [...new Set(this.connections().filter((x) => x.status === 'connected' && x.enabledCapabilities.length).map((x) => x.connectorId))];
  }

  /** Every action of every connector as a tool behind the Tool Runtime's policy gate. */
  tools(): AnyTool[] {
    const tools: AnyTool[] = [];
    for (const c of this.byId.values()) {
      for (const a of c.actions) {
        tools.push(
          defineTool({
            name: a.name,
            toolset: c.id,
            description: `${a.description} (${c.name}${c.auth.kind === 'none' ? '' : '; pass "account" when several accounts are connected'})`,
            input: a.input.extend({ account: z.string().max(200).optional().describe('Account name or id; optional when only one is connected') }),
            risk: { category: a.category, reversible: a.category === 'read', ...(a.untrusted ? { untrustedOutput: true } : {}) },
            idempotent: a.category === 'read',
            timeoutMs: 90_000,
            ...(a.preview ? { preview: (i: Record<string, unknown>) => a.preview!(i) } : {}),
            ...(a.riskFor ? { riskFor: (i: Record<string, unknown>) => a.riskFor!(i) } : {}),
            execute: async (input: Record<string, unknown>, ctx) => {
              const { account, ...args } = input;
              const conn = this.resolveConnection(c, account as string | undefined);
              if (!conn.enabledCapabilities.includes(a.capability)) throw new ConnectorError('capability_off', `"${c.capabilities.find((k) => k.id === a.capability)?.label ?? a.capability}" is turned off for ${c.name} (${conn.accountName}). The owner can turn it on in Integrations.`);
              const { api, secrets } = await this.client(conn, ctx.signal);
              const known = Object.values(secrets()).filter((v): v is string => !!v);
              const stateDoc = { ...(conn.state ?? {}) };
              try {
                const r = await a.run(args, {
                  api,
                  connection: conn,
                  secrets: secrets(),
                  signal: ctx.signal,
                  state: { get: <T>(k: string) => stateDoc[k] as T | undefined, set: (k, v) => void (stateDoc[k] = v) },
                });
                const now = this.o.clock.now();
                this.update(conn.id, { state: stateDoc, lastOkAt: now, updatedAt: now, ...(conn.status !== 'connected' ? { status: 'connected' as const } : {}) });
                const text = scrubSecrets(r.text, known);
                const source = `${c.id}:${conn.accountName}`;
                return {
                  content: a.untrusted ? `<untrusted source="${source}">\n${text}\n</untrusted>` : text,
                  data: r.data,
                  ...(a.untrusted ? { taint: [{ kind: a.untrusted, source, at: now }] } : {}),
                };
              } catch (error) {
                const e = error instanceof ConnectorError ? error : new ConnectorError('server', (error as Error).message);
                if (e.code === 'auth' || e.code === 'rate_limited') this.update(conn.id, { status: e.code === 'auth' ? 'needs_reauth' : 'rate_limited', lastError: e.message, updatedAt: this.o.clock.now() });
                throw new ConnectorError(e.code, scrubSecrets(e.message, known) + (e.retryAfterSec ? ` Try again in ${e.retryAfterSec} s.` : ''));
              }
            },
          }) as unknown as AnyTool,
        );
      }
    }
    return tools;
  }

  private resolveConnection(c: Connector, account?: string): Connection {
    const all = this.connections(c.id);
    if (c.auth.kind === 'none' && all.length === 0) return this.ensureLocal(c);
    const live = all.filter((x) => x.status !== 'needs_reauth');
    const pick = account ? all.filter((x) => x.id === account || x.accountName.toLowerCase() === account.toLowerCase() || x.accountId === account) : live.length ? live : all;
    if (pick.length === 0) throw new ConnectorError('not_connected', account ? `No ${c.name} account "${account}" is connected.` : `${c.name} isn't connected. The owner can connect it in Integrations.`);
    if (pick.length > 1) throw new ConnectorError('bad_request', `Several ${c.name} accounts are connected (${pick.map((x) => x.accountName).join(', ')}); say which with "account".`);
    const conn = pick[0]!;
    if (conn.status === 'needs_reauth') throw new ConnectorError('auth', `The ${c.name} connection for ${conn.accountName} expired or was revoked. The owner needs to reconnect it in Integrations.`);
    return conn;
  }

  private ensureLocal(c: Connector): Connection {
    const now = this.o.clock.now();
    const conn: Connection = { id: uuidv7(now), connectorId: c.id, accountId: 'local', accountName: 'This PC', status: 'connected', enabledCapabilities: c.capabilities.filter((k) => k.default).map((k) => k.id), createdAt: now, updatedAt: now };
    this.o.docs.put(KIND, conn);
    return conn;
  }

  private update(id: string, patch: Partial<Connection>) {
    const cur = this.o.docs.get<Connection>(KIND, id);
    if (cur) this.o.docs.put(KIND, { ...cur, ...patch });
  }

  private emit(e: { connectionId?: string; connectorId: string; event: string }) {
    for (const l of this.listeners) l(e);
  }

  private async auditEvent(connectorId: string, connectionId: string | undefined, event: string, summary: string, outcome: 'success' | 'failure', details: Record<string, unknown> = {}) {
    await this.o.audit?.append({ actor: 'owner', action: `connector.${connectorId}.${event}`, category: 'security', decision: 'system', outcome, summary, details: { connectorId, ...(connectionId ? { connectionId } : {}), ...details } });
  }
}

// ---------------------------------------------------------------- small helpers for connectors

export const bearer = (key = 'access_token') => (req: { headers: Record<string, string> }, s: Secrets) => {
  if (s[key]) req.headers.authorization = `Bearer ${s[key]}`;
};

export const lines = (items: string[], empty = 'Nothing found.') => (items.length ? items.join('\n') : empty);

export const clip = (s: unknown, n = 280) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
