import {
  type AutonomyPreset,
  HARD_FLOOR,
  type PermissionLevel,
  PRESETS,
  type RiskCategory,
  TAINT_ESCALATED,
  stricter,
} from './permissions.ts';
import type { SystemControl } from './system-control.ts';
import type { TaintSet } from './taint.ts';

export interface ProposedAction {
  tool: string;
  category: RiskCategory;
  args: unknown;
  taint: TaintSet;
  actor: 'agent' | 'owner' | 'scheduler';
  runId?: string;
}

export interface PolicyDecision {
  level: PermissionLevel;
  reason: string;
  /** Which rule decided: preset, override, hard floor, task grant, taint, or system stop. */
  rule: 'system_stopped' | 'preset' | 'tool_override' | 'category_override' | 'hard_floor' | 'task_grant' | 'taint';
  hardFloor: boolean;
}

/**
 * "Allow for this task": the owner lets one run control devices without asking at every click.
 * Only `device_control` can be granted; sending, deleting, buying and settings still ask.
 */
export interface TaskGrant {
  runId: string;
  category: 'device_control';
  expiresAt: number;
  approvalId: string;
}

export interface PolicyConfig {
  preset: AutonomyPreset;
  categoryOverrides?: Partial<Record<RiskCategory, PermissionLevel>>;
  toolOverrides?: Record<string, PermissionLevel>;
}

/**
 * Decides allow / notify / ask / deny for every tool call. Order of rules:
 * kill switch → tool override → category override → preset; then the hard floor and taint
 * escalation can only make the result stricter, never looser.
 */
export class PolicyEngine {
  private config: PolicyConfig;
  private readonly system: SystemControl;
  private readonly now: () => number;
  private grants: TaskGrant[] = [];

  constructor(deps: { config: PolicyConfig; system: SystemControl; now?: () => number }) {
    this.config = deps.config;
    this.system = deps.system;
    this.now = deps.now ?? Date.now;
    // STOP revokes every grant: after a resume, the owner decides again.
    deps.system.onChange((c) => {
      if (c.state === 'stopped') this.grants = [];
    });
  }

  grant(g: TaskGrant): void {
    this.grants = [...this.grants.filter((x) => x.runId !== g.runId || x.category !== g.category), g];
  }

  revokeGrants(runId?: string): void {
    this.grants = runId ? this.grants.filter((g) => g.runId !== runId) : [];
  }

  activeGrants(): TaskGrant[] {
    const now = this.now();
    return this.grants.filter((g) => g.expiresAt > now);
  }

  /** Settings changes come from the owner through the API; there is no agent tool for this. */
  setConfig(config: PolicyConfig): void {
    this.config = config;
  }

  getConfig(): PolicyConfig {
    return structuredClone(this.config);
  }

  decide(action: ProposedAction): PolicyDecision {
    if (this.system.stopped) {
      return { level: 'deny', reason: 'Feroxes is stopped', rule: 'system_stopped', hardFloor: false };
    }

    let level: PermissionLevel;
    let rule: PolicyDecision['rule'];
    const toolLevel = this.config.toolOverrides?.[action.tool];
    const categoryLevel = this.config.categoryOverrides?.[action.category];
    if (toolLevel) {
      level = toolLevel;
      rule = 'tool_override';
    } else if (categoryLevel) {
      level = categoryLevel;
      rule = 'category_override';
    } else {
      level = PRESETS[this.config.preset][action.category];
      rule = 'preset';
    }
    let reason = `${action.category} → ${level} (${rule === 'preset' ? `preset ${this.config.preset}` : rule.replace('_', ' ')})`;

    const hardFloor = HARD_FLOOR.has(action.category);
    if (hardFloor && level !== 'deny' && level !== 'ask') {
      level = 'ask';
      rule = 'hard_floor';
      reason = `${action.category} actions always need your approval`;
    }

    // A task grant covers device control even though the run reads the screen (which taints it):
    // the owner accepted that for this task. It never covers other categories.
    if (action.category === 'device_control' && level !== 'deny' && action.runId && this.activeGrants().some((g) => g.runId === action.runId)) {
      return { level: 'allow', reason: 'device control allowed for this task by the owner', rule: 'task_grant', hardFloor };
    }

    if (action.taint.tainted && TAINT_ESCALATED.has(action.category) && level !== 'deny') {
      const escalated = stricter(level, 'ask');
      if (escalated !== level) {
        level = escalated;
        rule = 'taint';
        reason = `this run read untrusted content (${action.taint.list().map((t) => t.source).slice(0, 3).join(', ')}), so outward actions need approval`;
      }
    }

    return { level, reason, rule, hardFloor };
  }
}
