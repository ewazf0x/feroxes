import type { Budget } from '@feroxes/metering';
import { Db } from './db.ts';
import {
  SqliteAgentStore,
  SqliteApprovalStore,
  SqliteArtifactStore,
  SqliteAuditStore,
  SqliteBudgetStore,
  SqliteDocStore,
  SqliteMemoryStore,
  SqliteSystemStateStore,
  SqliteToolCallStore,
  SqliteUsageLedgerStore,
} from './stores.ts';

export * from './db.ts';
export * from './stores.ts';

/** Opens (and migrates) the Feroxes database file and returns every store. */
export function openStores(path: string, budgets: Budget[] = []) {
  const db = new Db(path);
  return {
    db,
    agent: new SqliteAgentStore(db),
    memory: new SqliteMemoryStore(db),
    ledger: new SqliteUsageLedgerStore(db),
    budgets: new SqliteBudgetStore(db, budgets),
    audit: new SqliteAuditStore(db),
    approvals: new SqliteApprovalStore(db),
    system: new SqliteSystemStateStore(db),
    toolCalls: new SqliteToolCallStore(db),
    artifacts: new SqliteArtifactStore(db),
    docs: new SqliteDocStore(db),
  };
}

export type FeroxesStores = ReturnType<typeof openStores>;
