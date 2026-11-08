import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'node:child_process';
import type { TokenUsage } from '@feroxes/metering';
import { ProviderError } from '../errors.ts';
import type { AdapterEvent, AdapterRequest, FinishReason, LlmMessage, ModelEntry, ProviderAdapter, ToolCall } from '../types.ts';

/**
 * Kiro as Feroxes's main reasoning engine, driven through the official Kiro CLI the way its docs
 * describe for local scripts: `kiro-cli chat --no-interactive` with the prompt on stdin and the
 * answer on stdout (https://kiro.dev/docs/cli/headless). The owner asked for this and accepts that
 * it uses their Kiro subscription.
 *
 * Kiro is used only as a *reasoner*: Feroxes renders the conversation and the available tools into
 * one prompt and parses Kiro's reply. Feroxes never passes --trust-all-tools, so Kiro CLI's own
 * tools stay off and every real tool call still goes through Feroxes's policy gate, approvals and
 * audit log. That keeps "it proposes, I decide" intact even with Kiro in the middle.
 *
 * Because the CLI prints the first response once (no token streaming) and reports no token counts,
 * this adapter emits the answer as a single delta and estimates usage for the ledger. Kiro models
 * are priced at $0 per token in the catalog: usage is billed as subscription credits, not per token.
 */

export const TOOL_SENTINEL = '⟦FEROXES_TOOL⟧';

export interface SpawnResult {
  stdout: AsyncIterable<string> | string;
  stderrText: Promise<string>;
  exitCode: Promise<number>;
  kill: () => void;
}

export type SpawnLike = (prompt: string, args: string[], signal: AbortSignal) => SpawnResult;

export interface KiroAdapterOptions {
  /** Path to the Kiro CLI binary. */
  command?: string;
  /** Extra args after `chat --no-interactive` (e.g. an --agent that disables Kiro's own tools). */
  extraArgs?: string[];
  apiKey?: string;
  /** Working directory; Kiro saves sessions per directory. */
  cwd?: string;
  /** Injected for tests, so no real subprocess is needed. */
  spawn?: SpawnLike;
  /** Hard cap on one invocation; also bounded by the router's per-attempt timeout. */
  timeoutMs?: number;
}

export class KiroAdapter implements ProviderAdapter {
  readonly kind = 'kiro' as const;
  private readonly o: Required<Omit<KiroAdapterOptions, 'apiKey' | 'spawn' | 'cwd'>> & Pick<KiroAdapterOptions, 'apiKey' | 'cwd'>;
  private readonly spawnImpl: SpawnLike;

  constructor(options: KiroAdapterOptions = {}) {
    this.o = { command: options.command ?? 'kiro-cli', extraArgs: options.extraArgs ?? [], timeoutMs: options.timeoutMs ?? 300_000, ...(options.apiKey ? { apiKey: options.apiKey } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) };
    this.spawnImpl = options.spawn ?? ((prompt, args, signal) => this.realSpawn(prompt, args, signal));
  }

  async *stream(model: ModelEntry, req: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const prompt = renderPrompt(model, req);
    // Kiro picks the underlying model; modelKey 'default' means "let Kiro's agent decide".
    const args = ['chat', '--no-interactive', ...this.o.extraArgs, ...(model.modelKey && model.modelKey !== 'default' ? ['--model', model.modelKey] : [])];
    const result = this.spawnImpl(prompt, args, signal);

    let text = '';
    try {
      if (typeof result.stdout === 'string') text = result.stdout;
      else for await (const chunk of result.stdout) text += chunk;
    } catch (error) {
      result.kill();
      if (signal.aborted) throw new ProviderError('cancelled', 'Kiro run cancelled');
      throw new ProviderError('network', `Could not run Kiro CLI: ${(error as Error).message}. Is "${this.o.command}" installed and on PATH?`, { cause: error });
    }

    const exitCode = await result.exitCode;
    if (exitCode !== 0) throw classifyKiroFailure(exitCode, await result.stderrText);

    const clean = stripControl(text).trim();
    const tool = parseToolCall(clean);
    const usage = estimateUsage(prompt, clean);

    if (tool) {
      yield { type: 'tool-call', call: tool };
      yield { type: 'finish', reason: 'tool_calls' as FinishReason, usage };
      return;
    }
    if (clean) yield { type: 'text-delta', text: clean };
    yield { type: 'finish', reason: 'stop' as FinishReason, usage };
  }

  private realSpawn(prompt: string, args: string[], signal: AbortSignal): SpawnResult {
    const child: ChildProcessWithoutNullStreams = nodeSpawn(this.o.command, args, {
      cwd: this.o.cwd ?? process.cwd(),
      env: { ...process.env, ...(this.o.apiKey ? { KIRO_API_KEY: this.o.apiKey } : {}), NO_COLOR: '1', KIRO_LOG_NO_COLOR: '1' },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), this.o.timeoutMs);
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdin.write(prompt);
    child.stdin.end();
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8').slice(0, 20_000);
    });

    async function* readStdout() {
      for await (const chunk of child.stdout) yield (chunk as Buffer).toString('utf8');
    }
    const exitCode = new Promise<number>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(signal.aborted && code !== 0 ? 0 /* treated as cancel upstream */ : (code ?? 1));
      });
      child.on('error', () => resolve(1));
    });
    return { stdout: readStdout(), stderrText: Promise.resolve().then(() => exitCode).then(() => stderr), exitCode, kill: () => child.kill('SIGKILL') };
  }
}

/** Renders the conversation and tool list into one instruction for Kiro CLI. */
export function renderPrompt(model: ModelEntry, req: AdapterRequest): string {
  const parts: string[] = [];
  const systems = req.messages.filter((m): m is Extract<LlmMessage, { role: 'system' }> => m.role === 'system').map((m) => m.content);
  if (systems.length) parts.push(systems.join('\n\n'));

  if (req.tools?.length) {
    parts.push(
      [
        'You can use tools. When you want to use one, reply with EXACTLY one line and nothing else:',
        `${TOOL_SENTINEL} {"name":"<tool>","arguments":{...}}`,
        'Otherwise, reply to the owner normally. Never mention this tool protocol to the owner.',
        'Available tools:',
        ...req.tools.map((t) => `- ${t.name}: ${t.description} — arguments JSON Schema: ${JSON.stringify(t.parameters)}`),
      ].join('\n'),
    );
  }
  if (req.output) parts.push(`Reply with a single JSON object matching this schema and nothing else:\n${JSON.stringify(req.output.schema)}`);

  const lines: string[] = ['Conversation so far:'];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') lines.push(`Owner: ${renderContent(m.content)}`);
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`You: ${m.content}`);
      for (const c of m.toolCalls ?? []) lines.push(`You (tool call): ${c.name} ${JSON.stringify(c.args ?? {})}`);
    } else lines.push(`Tool result (${m.toolName}${m.isError ? ', error' : ''}): ${m.content}`);
  }
  lines.push('You:');
  parts.push(lines.join('\n'));
  return parts.join('\n\n');
}

function renderContent(content: Extract<LlmMessage, { role: 'user' }>['content']): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '[image omitted: not supported through Kiro CLI]')).join('\n');
}

/** Finds a tool call on its own line (tolerates code fences and stray prose around it). */
export function parseToolCall(text: string): ToolCall | undefined {
  const idx = text.indexOf(TOOL_SENTINEL);
  if (idx === -1) return undefined;
  const after = text.slice(idx + TOOL_SENTINEL.length).replace(/^```(?:json)?/i, '').trim();
  const start = after.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < after.length; i++) {
    const ch = after[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') esc = true;
    else if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '{') depth++;
    else if (!inStr && ch === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return undefined;
  try {
    const parsed = JSON.parse(after.slice(start, end)) as { name?: string; arguments?: unknown; args?: unknown };
    if (!parsed.name || typeof parsed.name !== 'string') return undefined;
    return { id: `kiro_${Date.now().toString(36)}`, name: parsed.name, args: (parsed.arguments ?? parsed.args ?? {}) as unknown };
  } catch {
    return undefined;
  }
}

function estimateUsage(prompt: string, output: string): TokenUsage {
  return { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(output.length / 4) };
}

function stripControl(text: string): string {
  // Remove ANSI escapes and the "[cloud] session …" line Kiro may print; keep real content.
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/^\[cloud] session .*$/gm, '').replace(/^\s*stopping \(exit \d+\)\s*$/gm, '');
}

/**
 * Maps a Kiro CLI failure to a Feroxes error class so the router fails over to the API models.
 * Exit codes per https://kiro.dev/docs/reference/exit-codes; auth/quota stderr text isn't
 * documented, so common wording is matched and anything else is retryable (triggers failover).
 */
export function classifyKiroFailure(exitCode: number, stderr: string): ProviderError {
  const s = stderr.toLowerCase();
  const msg = `Kiro CLI exited ${exitCode}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`;
  if (exitCode === 4) return new ProviderError('invalid_request', `Kiro agent not found. ${msg}`, { status: 4 });
  if (/unauthor|forbidden|api key|sign ?in|not logged|authenticat|invalid token/.test(s)) return new ProviderError('auth_error', msg);
  if (/credit|quota|insufficient|limit reached|out of|purchase|upgrade/.test(s)) return new ProviderError('quota_exhausted', msg);
  if (/rate|throttl|too many|429/.test(s)) return new ProviderError('rate_limited', msg);
  if (/timed? ?out|timeout/.test(s)) return new ProviderError('timeout', msg);
  // Unknown failure: retryable so Feroxes falls over to a fallback model instead of giving up.
  return new ProviderError('server_error', msg, { status: exitCode });
}
