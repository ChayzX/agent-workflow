// Durable relational storage on Node's built-in SQLite (no native compilation needed).
// WAL mode lets the CLI and dashboard read while the supervisor writes.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Param = SQLInputValue;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, goal_text TEXT NOT NULL, goal_sha256 TEXT NOT NULL,
    status TEXT NOT NULL, repo_mode TEXT NOT NULL, repo_source TEXT NOT NULL, workspace_dir TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main', settings TEXT NOT NULL, plan TEXT, status_reason TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  -- The goal baseline is immutable: block any update that changes it.
  CREATE TRIGGER projects_goal_immutable BEFORE UPDATE OF goal_text, goal_sha256 ON projects
  WHEN NEW.goal_text IS NOT OLD.goal_text OR NEW.goal_sha256 IS NOT OLD.goal_sha256
  BEGIN SELECT RAISE(ABORT, 'goal baseline is immutable'); END;

  CREATE TABLE requirements (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL,
    mandatory INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open', evidence TEXT NOT NULL DEFAULT '[]', blocker TEXT,
    github_issue_number INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(project_id, key)
  );

  CREATE TABLE work_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL,
    type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL,
    requirement_keys TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]', paths TEXT NOT NULL DEFAULT '[]',
    role TEXT NOT NULL, complexity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 1,
    milestone TEXT, status TEXT NOT NULL, branch TEXT, base_commit TEXT, head_commit TEXT,
    reviewed_commit TEXT, gated_commit TEXT, merged_commit TEXT,
    implementer_agent_id TEXT, implementer_provider TEXT, remediation_rounds INTEGER NOT NULL DEFAULT 0,
    pr_number INTEGER, github_issue_number INTEGER, status_reason TEXT, source TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(project_id, key)
  );
  CREATE INDEX work_items_status ON work_items(project_id, status);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL,
    name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', responsibility TEXT NOT NULL,
    current_task_id TEXT, last_provider TEXT, activations INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(project_id, name)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), work_item_id TEXT,
    kind TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT, status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1, complexity TEXT NOT NULL DEFAULT 'medium',
    provider TEXT, provider_pinned TEXT, exclude_providers TEXT NOT NULL DEFAULT '[]', exclude_agents TEXT NOT NULL DEFAULT '[]',
    not_before INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 4,
    lease_owner TEXT, lease_expires_at INTEGER, heartbeat_at INTEGER, pid INTEGER,
    idempotency_key TEXT NOT NULL UNIQUE, input TEXT NOT NULL, output TEXT,
    error_class TEXT, error_message TEXT, session_id TEXT, session_provider TEXT, workspace_path TEXT,
    read_only INTEGER NOT NULL DEFAULT 0, parent_task_id TEXT, processed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_unprocessed ON tasks(status, processed);
  CREATE INDEX tasks_dispatch ON tasks(status, not_before, priority);
  CREATE INDEX tasks_project ON tasks(project_id, status);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT, provider TEXT NOT NULL,
    provider_session_id TEXT, model TEXT, mode TEXT NOT NULL, status TEXT NOT NULL,
    failure_class TEXT, prompt_chars INTEGER NOT NULL DEFAULT 0, exit_code INTEGER,
    started_at INTEGER NOT NULL, ended_at INTEGER, transcript_path TEXT
  );
  CREATE INDEX sessions_task ON sessions(task_id);

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, project_id TEXT, task_id TEXT, session_id TEXT,
    provider TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
    reported_cost_usd REAL, source TEXT NOT NULL
  );

  CREATE TABLE provider_state (
    provider TEXT PRIMARY KEY, status TEXT NOT NULL, limit_kind TEXT, reset_at INTEGER,
    next_probe_at INTEGER, backoff_level INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    windows TEXT NOT NULL DEFAULT '{}', model_limits TEXT NOT NULL DEFAULT '{}', details TEXT NOT NULL DEFAULT '{}',
    reset_source TEXT, updated_at INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, thread_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
    sender_agent_id TEXT NOT NULL, recipient_agent_id TEXT, recipient_role TEXT, type TEXT NOT NULL,
    body TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
    blocking INTEGER NOT NULL DEFAULT 0, depth INTEGER NOT NULL DEFAULT 0, dedup_hash TEXT NOT NULL,
    reply_to TEXT, created_at INTEGER NOT NULL, processed_at INTEGER,
    UNIQUE(project_id, sender_agent_id, dedup_hash)
  );
  CREATE INDEX messages_state ON messages(project_id, state);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, problem TEXT NOT NULL,
    alternatives TEXT NOT NULL DEFAULT '[]', proposal TEXT, status TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 1,
    max_rounds INTEGER NOT NULL DEFAULT 2, proposer_agent_id TEXT, owner_agent_id TEXT, outcome TEXT, rationale TEXT,
    consequences TEXT, security_resolutions TEXT NOT NULL DEFAULT '[]', adr_path TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, key)
  );

  CREATE TABLE decision_positions (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, agent_id TEXT NOT NULL, provider TEXT, round INTEGER NOT NULL,
    phase TEXT NOT NULL, stance TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]',
    risks TEXT NOT NULL DEFAULT '[]', objections TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
    UNIQUE(decision_id, agent_id, round, phase)
  );

  CREATE TABLE findings (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id TEXT, task_id TEXT, reviewer_agent_id TEXT,
    reviewer_provider TEXT, commit_sha TEXT, severity TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
    locations TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL, explanation TEXT NOT NULL, remediation TEXT NOT NULL,
    verification TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution_evidence TEXT,
    defect_work_item_id TEXT, source TEXT NOT NULL DEFAULT 'review', fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, fingerprint)
  );

  CREATE TABLE gate_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id TEXT, scope TEXT NOT NULL, commit_sha TEXT NOT NULL,
    name TEXT NOT NULL, command TEXT NOT NULL, required INTEGER NOT NULL, status TEXT NOT NULL, exit_code INTEGER,
    duration_ms INTEGER, output_excerpt TEXT, log_path TEXT, started_at INTEGER NOT NULL
  );
  CREATE INDEX gate_runs_commit ON gate_runs(project_id, commit_sha);

  CREATE TABLE audits (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, commit_sha TEXT, status TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1, result TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE releases (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version TEXT NOT NULL, commit_sha TEXT NOT NULL, status TEXT NOT NULL,
    zip_path TEXT, sha256 TEXT, manifest TEXT, verification_log TEXT, github_release_url TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, version)
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, project_id TEXT, action TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, decided_by TEXT, dedup_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, decided_at INTEGER
  );

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_item_id TEXT, task_id TEXT, kind TEXT NOT NULL,
    summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  );
  CREATE INDEX checkpoints_wi ON checkpoints(project_id, work_item_id);

  CREATE TABLE github_objects (
    project_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, number INTEGER, node_id TEXT, db_id INTEGER,
    url TEXT, extra TEXT NOT NULL DEFAULT '{}', synced_at INTEGER NOT NULL, PRIMARY KEY(project_id, kind, key)
  );

  CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '{}',
    issued_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at INTEGER NOT NULL, processed_at INTEGER
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, project_id TEXT, task_id TEXT, level TEXT NOT NULL,
    type TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_project ON events(project_id, id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    project_id TEXT, target TEXT, detail TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  );
  -- Audit log is append-only.
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

  CREATE TABLE dashboard_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `,
  // v2 — agent VM leases (security.agentBackend = "devvm")
  `
  CREATE TABLE vm_leases (
    id TEXT PRIMARY KEY, project_id TEXT, work_item_id TEXT, purpose TEXT NOT NULL, status TEXT NOT NULL,
    cpus INTEGER NOT NULL, ram_mib INTEGER NOT NULL, disk_gib INTEGER NOT NULL, expires_at INTEGER,
    generation INTEGER NOT NULL DEFAULT 1, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX vm_leases_item ON vm_leases(work_item_id, status);
  CREATE INDEX vm_leases_status ON vm_leases(status, purpose);
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.raw.prepare('INSERT INTO schema_version(version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(MIGRATIONS[version]!);
        version += 1;
        this.raw.prepare('UPDATE schema_version SET version = ?').run(version);
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    }
  }

  schemaVersion(): number {
    return (this.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    const r = this.raw.prepare(sql).get(...params);
    return r ? ({ ...r } as T) : undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params).map((r) => ({ ...r }) as T);
  }

  /** Run fn inside an IMMEDIATE transaction (writer lock acquired up front → atomic claims). Nested calls join. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  meta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  integrityCheck(): string {
    return (this.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  }

  /** Consistent online backup using VACUUM INTO. */
  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.raw.prepare('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.raw.close();
  }
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
