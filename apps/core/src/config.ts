import { isValidTimeZone } from '@feroxes/shared';
import * as z from 'zod/v4';

/**
 * Environment configuration (project structure §5). Provider keys may come from the environment
 * for a first run; the setup flow moves them into the vault.
 */
export const EnvSchema = z.object({
  FEROXES_TIMEZONE: z.string().default('UTC').refine(isValidTimeZone, 'not a valid IANA time zone'),
  FEROXES_WORKSPACE_DIR: z.string().default('./workspace'),
  FEROXES_DATA_DIR: z.string().default('./data'),
  FEROXES_MASTER_KEY: z.string().optional(),
  FEROXES_PRESET: z.enum(['observer', 'assistant', 'delegate', 'autopilot']).default('assistant'),
  FEROXES_DAILY_BUDGET_USD: z.coerce.number().positive().default(2),
  FEROXES_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(30),
  FEROXES_BACKGROUND_DAILY_USD: z.coerce.number().positive().default(0.25),
  FEROXES_OWNER_NAME: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** "paid" lifts the free-tier data restriction (architecture §3.2 of the tech stack). */
  GEMINI_TIER: z.enum(['free', 'paid']).default('free'),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(), // e.g. http://localhost:11434/v1 when Ollama runs on the same PC
  OLLAMA_MODEL: z.string().default('qwen3:8b'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default('21m00Tcm4TlvDq8ikWAM'),
  ELEVENLABS_TTS_MODEL: z.string().default('eleven_flash_v2_5'),
  ELEVENLABS_STT_MODEL: z.string().default('scribe_v2'),
  /** Port the apps connect to (device WebSocket + API, next milestone). */
  FEROXES_PORT: z.coerce.number().int().default(7311),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}
