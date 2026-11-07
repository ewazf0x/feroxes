export const RISK_CATEGORIES = [
  'read',
  'internal_write',
  'external_write',
  'communicate',
  'destructive',
  'device_control',
  'financial',
  'security',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export type PermissionLevel = 'allow' | 'notify' | 'ask' | 'deny';

export const LEVEL_ORDER: Record<PermissionLevel, number> = { allow: 0, notify: 1, ask: 2, deny: 3 };

export const stricter = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b);

export type AutonomyPreset = 'observer' | 'assistant' | 'delegate' | 'autopilot';

/** Default permission matrix per preset (architecture §9.1–9.2). */
export const PRESETS: Record<AutonomyPreset, Record<RiskCategory, PermissionLevel>> = {
  observer: { read: 'allow', internal_write: 'ask', external_write: 'deny', communicate: 'deny', destructive: 'deny', device_control: 'deny', financial: 'deny', security: 'deny' },
  assistant: { read: 'allow', internal_write: 'allow', external_write: 'ask', communicate: 'ask', destructive: 'ask', device_control: 'ask', financial: 'ask', security: 'ask' },
  delegate: { read: 'allow', internal_write: 'allow', external_write: 'notify', communicate: 'ask', destructive: 'ask', device_control: 'ask', financial: 'ask', security: 'ask' },
  autopilot: { read: 'allow', internal_write: 'allow', external_write: 'allow', communicate: 'notify', destructive: 'ask', device_control: 'notify', financial: 'ask', security: 'ask' },
};

/** Categories that always need the owner's approval, whatever the preset or overrides say. */
export const HARD_FLOOR: ReadonlySet<RiskCategory> = new Set(['financial', 'security']);

/** In a tainted run, these categories are escalated to at least `ask` (architecture §9.3). */
export const TAINT_ESCALATED: ReadonlySet<RiskCategory> = new Set(['external_write', 'communicate', 'destructive', 'device_control']);
