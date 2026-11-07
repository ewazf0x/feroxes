import type { Sensitivity } from '@feroxes/shared';

export type MemoryLayer = 'episodic' | 'semantic' | 'procedural';

export type MemoryKind =
  // semantic
  | 'fact' | 'preference' | 'relationship' | 'goal' | 'commitment'
  // episodic
  | 'event' | 'conversation' | 'digest_day' | 'digest_week' | 'digest_month'
  // procedural
  | 'rule' | 'procedure' | 'style';

export const LAYER_OF: Record<MemoryKind, MemoryLayer> = {
  fact: 'semantic', preference: 'semantic', relationship: 'semantic', goal: 'semantic', commitment: 'semantic',
  event: 'episodic', conversation: 'episodic', digest_day: 'episodic', digest_week: 'episodic', digest_month: 'episodic',
  rule: 'procedural', procedure: 'procedural', style: 'procedural',
};

export type MemoryStatus = 'active' | 'superseded' | 'merged' | 'archived';

export type MemorySourceKind = 'owner_asserted' | 'extracted' | 'consolidated' | 'imported';

export type Actor = 'owner' | 'agent' | 'extractor' | 'consolidator';

export interface Memory {
  id: string;
  layer: MemoryLayer;
  kind: MemoryKind;
  title?: string;
  content: string;
  structured?: Record<string, unknown>;
  importance: number; // 0..1
  confidence: number; // 0..1
  evidenceCount: number;
  sensitivity: Sensitivity;
  status: MemoryStatus;
  pinned: boolean;
  source: MemorySourceKind;
  occurredAt?: number;
  validFrom?: number;
  validTo?: number;
  supersedesId?: string;
  mergedIntoId?: string;
  contentHash: string;
  version: number;
  accessCount: number;
  lastAccessedAt?: number;
  createdAt: number;
  updatedAt: number;
  entityIds: string[];
}

export interface MemorySourceRef {
  memoryId: string;
  sourceType: 'message' | 'session' | 'run' | 'tool_call' | 'web' | 'import' | 'memory';
  sourceId: string;
  excerpt?: string;
}

export type MemoryEventType = 'created' | 'updated' | 'superseded' | 'merged' | 'archived' | 'restored' | 'pinned' | 'unpinned' | 'deleted' | 'evidence';

export interface MemoryEvent {
  id: string;
  memoryId: string;
  type: MemoryEventType;
  actor: Actor;
  before?: Partial<Memory>;
  after?: Partial<Memory>;
  reason: string;
  runId?: string;
  createdAt: number;
}

export interface Entity {
  id: string;
  kind: 'person' | 'org' | 'project' | 'place' | 'account' | 'topic' | 'thing';
  name: string;
  aliases: string[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryLink {
  fromId: string;
  toId: string;
  type: 'derived_from' | 'part_of' | 'contradicts' | 'supports' | 'related';
}

export interface Suppression {
  id: string;
  contentHash: string;
  embedding?: number[];
  spaceId?: string;
  pattern: string;
  reason: string;
  createdAt: number;
}

export interface ScoreBreakdown {
  rrf: number;
  ranks: { vector?: number; text?: number; entity?: number };
  importance: number;
  recency: number;
  confidence: number;
  total: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  breakdown: ScoreBreakdown;
}
