import type { ApprovalPreview, RiskCategory, TaintSet, TaintSource } from '@feroxes/policy';
import type { Logger } from '@feroxes/shared';
import * as z from 'zod/v4';

export interface ToolResult<O = unknown> {
  /** What the model sees. Keep it short; large data goes to `data` and artifacts. */
  content: string;
  data?: O;
  isError?: boolean;
  /** Untrusted sources this result introduces (web pages, emails …). */
  taint?: TaintSource[];
}

export interface ToolContext {
  runId: string;
  callId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  taint: TaintSet;
  log: Logger;
  timeZone: string;
  progress(message: string): void;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string; // 'files.write'
  toolset: string; // 'files'
  description: string; // written for the model
  input: I;
  risk: { category: RiskCategory; reversible: boolean; untrustedOutput?: boolean };
  /** Risk can depend on arguments, e.g. overwriting a file is destructive, creating one is not. */
  riskFor?(input: z.infer<I>): RiskCategory;
  /** Safe to execute again after a crash (reads). Side-effecting tools must say false. */
  idempotent: boolean;
  timeoutMs?: number;
  preview?(input: z.infer<I>): ApprovalPreview;
  execute(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult<O>>;
}

export type AnyTool = ToolDefinition<z.ZodType, unknown>;

export function defineTool<I extends z.ZodType, O>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(def.name)) throw new Error(`tool name "${def.name}" must look like "toolset.action"`);
  return def;
}

/** Model-facing tool name: providers allow [a-zA-Z0-9_-], so dots become double underscores. */
export const wireName = (name: string) => name.replaceAll('.', '__');
export const fromWireName = (wire: string) => wire.replaceAll('__', '.');

export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export { z };
