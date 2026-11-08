import * as z from 'zod/v4';

/**
 * Device protocol v1 (architecture §10, revision in docs/06): JSON text frames over a WebSocket
 * from each app to the Core. Commands are signed by the Core (Ed25519 over the exact payload
 * string), so a device only executes commands its paired Core issued.
 */
export const PROTOCOL_VERSION = 1;

export const Platform = z.enum(['windows', 'macos', 'linux', 'android']);
export type Platform = z.infer<typeof Platform>;

export const deviceKind = (p: Platform): 'desktop' | 'phone' => (p === 'android' ? 'phone' : 'desktop');

export const Capability = z.enum([
  'screen.capture', 'ui.tree', 'ui.act', 'input.pointer', 'input.keyboard', 'gesture', 'global.action',
  'apps.list', 'apps.launch', 'windows.list', 'windows.focus', 'clipboard', 'fs', 'shell',
  'notifications.read', 'notifications.reply', 'audio.play', 'audio.record', 'system.status', 'system.wake', 'kiro.cli',
]);
export type Capability = z.infer<typeof Capability>;

// ---------- command parameters, one schema per action ----------

const Point = { x: z.number().int().min(0).max(20_000), y: z.number().int().min(0).max(20_000) };

export const ACTIONS = {
  'screen.capture': { capability: 'screen.capture', params: z.object({ display: z.number().int().min(0).max(8).optional(), windowId: z.string().max(100).optional(), maxWidth: z.number().int().min(320).max(3840).default(1280) }) },
  'ui.tree': { capability: 'ui.tree', params: z.object({ windowId: z.string().max(100).optional(), maxNodes: z.number().int().min(10).max(2000).default(400) }) },
  'ui.act': { capability: 'ui.act', params: z.object({ elementId: z.string().min(1).max(200), action: z.enum(['invoke', 'click', 'set_value', 'toggle', 'focus', 'expand', 'collapse', 'select', 'scroll_into_view', 'scroll_forward', 'scroll_backward']), value: z.string().max(10_000).optional() }) },
  'input.click': { capability: 'input.pointer', params: z.object({ ...Point, button: z.enum(['left', 'right', 'middle']).default('left'), double: z.boolean().default(false) }) },
  'input.type': { capability: 'input.keyboard', params: z.object({ text: z.string().min(1).max(10_000) }) },
  'input.key': { capability: 'input.keyboard', params: z.object({ keys: z.array(z.string().min(1).max(20)).min(1).max(5) }) },
  'input.scroll': { capability: 'input.pointer', params: z.object({ dx: z.number().int().min(-5000).max(5000).default(0), dy: z.number().int().min(-5000).max(5000), x: z.number().int().optional(), y: z.number().int().optional() }) },
  'gesture.tap': { capability: 'gesture', params: z.object({ ...Point, long: z.boolean().default(false) }) },
  'gesture.swipe': { capability: 'gesture', params: z.object({ x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int(), durationMs: z.number().int().min(50).max(5000).default(300) }) },
  'global.action': { capability: 'global.action', params: z.object({ action: z.enum(['back', 'home', 'recents', 'notifications', 'quick_settings', 'lock_screen']) }) },
  'apps.list': { capability: 'apps.list', params: z.object({}) },
  'apps.launch': { capability: 'apps.launch', params: z.object({ app: z.string().min(1).max(200).describe('App name on desktop, package name on Android'), args: z.array(z.string().max(500)).max(10).default([]) }) },
  'windows.list': { capability: 'windows.list', params: z.object({}) },
  'windows.focus': { capability: 'windows.focus', params: z.object({ windowId: z.string().min(1).max(100) }) },
  'clipboard.read': { capability: 'clipboard', params: z.object({}) },
  'clipboard.write': { capability: 'clipboard', params: z.object({ text: z.string().max(100_000) }) },
  'fs.list': { capability: 'fs', params: z.object({ path: z.string().min(1).max(1000) }) },
  'fs.read': { capability: 'fs', params: z.object({ path: z.string().min(1).max(1000) }) },
  'fs.write': { capability: 'fs', params: z.object({ path: z.string().min(1).max(1000), content: z.string().max(2_000_000), overwrite: z.boolean().default(false) }) },
  'shell.run': { capability: 'shell', params: z.object({ command: z.string().min(1).max(4000), cwd: z.string().max(1000).optional(), timeoutMs: z.number().int().min(1000).max(600_000).default(60_000) }) },
  'notifications.list': { capability: 'notifications.read', params: z.object({ app: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20) }) },
  'notifications.reply': { capability: 'notifications.reply', params: z.object({ key: z.string().min(1).max(500), text: z.string().min(1).max(4000) }) },
  'audio.play': { capability: 'audio.play', params: z.object({ url: z.string().max(2000), mime: z.string().max(100) }) },
  'system.status': { capability: 'system.status', params: z.object({}) },
  'system.schedule_wake': { capability: 'system.wake', params: z.object({ at: z.number().int().describe('epoch ms'), reason: z.string().max(200) }) },
  'kiro.run': { capability: 'kiro.cli', params: z.object({ repoPath: z.string().min(1).max(1000), task: z.string().min(1).max(20_000), trustTools: z.array(z.string().max(100)).max(30).default([]), timeoutMs: z.number().int().min(10_000).max(3_600_000).default(900_000) }) },
} as const satisfies Record<string, { capability: Capability; params: z.ZodType }>;

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];
export type ActionParams<A extends ActionName> = z.infer<(typeof ACTIONS)[A]['params']>;

/** Visible input moves the owner's cursor or keyboard focus; it pauses while the owner is active. */
export const VISIBLE_INPUT: ReadonlySet<ActionName> = new Set(['input.click', 'input.type', 'input.key', 'input.scroll', 'gesture.tap', 'gesture.swipe']);

// ---------- frames ----------

export const DeviceState = z.object({
  locked: z.boolean().optional(),
  foregroundApp: z.string().max(200).optional(),
  battery: z.object({ percent: z.number().min(0).max(100), charging: z.boolean() }).optional(),
  network: z.enum(['offline', 'wifi', 'ethernet', 'cellular', 'unknown']).optional(),
  cpuPercent: z.number().min(0).max(100).optional(),
  memoryPercent: z.number().min(0).max(100).optional(),
  diskFreeGb: z.number().min(0).optional(),
  idleSeconds: z.number().min(0).optional(),
});
export type DeviceState = z.infer<typeof DeviceState>;

export const DeviceInfo = z.object({ name: z.string().min(1).max(100), platform: Platform, appVersion: z.string().max(40), capabilities: z.array(Capability).max(40) });
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const DeviceToCore = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pair'), v: z.literal(PROTOCOL_VERSION), code: z.string().min(6).max(20), device: DeviceInfo }),
  z.object({ type: z.literal('hello'), v: z.literal(PROTOCOL_VERSION), deviceId: z.string().max(100), token: z.string().max(200), device: DeviceInfo }),
  z.object({ type: z.literal('result'), id: z.string().max(100), ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string().max(60), message: z.string().max(2000) }).optional() }),
  z.object({ type: z.literal('event'), event: z.enum(['owner_activity', 'local_stop', 'local_resume', 'notification', 'foreground_changed', 'screen_locked', 'screen_unlocked']), data: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ type: z.literal('heartbeat'), state: DeviceState }),
]);
export type DeviceToCore = z.infer<typeof DeviceToCore>;

export const CommandPayload = z.object({
  id: z.string(),
  deviceId: z.string(),
  action: z.string(),
  params: z.unknown(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  runId: z.string().optional(),
});
export type CommandPayload = z.infer<typeof CommandPayload>;

export const CoreToDevice = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paired'), deviceId: z.string(), token: z.string(), coreKey: z.string().describe('Ed25519 public key, base64url (raw 32 bytes)') }),
  z.object({ type: z.literal('welcome'), deviceId: z.string(), serverTime: z.number().int(), coreKey: z.string(), stopped: z.boolean() }),
  z.object({ type: z.literal('command'), payload: z.string().describe('JSON of CommandPayload; verify sig over these exact bytes'), sig: z.string().describe('base64url Ed25519 signature') }),
  z.object({ type: z.literal('cancel'), id: z.string() }),
  z.object({ type: z.literal('halt'), reason: z.string() }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type CoreToDevice = z.infer<typeof CoreToDevice>;

/** JSON Schema bundle for code generation in the Rust and Kotlin apps. */
export function deviceProtocolJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `Feroxes device protocol v${PROTOCOL_VERSION}`,
    $defs: {
      DeviceToCore: z.toJSONSchema(DeviceToCore),
      CoreToDevice: z.toJSONSchema(CoreToDevice),
      CommandPayload: z.toJSONSchema(CommandPayload),
      DeviceState: z.toJSONSchema(DeviceState),
      actions: Object.fromEntries(ACTION_NAMES.map((a) => [a, { capability: ACTIONS[a].capability, params: z.toJSONSchema(ACTIONS[a].params) }])),
    },
  };
}
