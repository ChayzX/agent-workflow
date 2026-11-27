// Automatic team assembly and dynamic specialist activation. Agents are durable identities
// (role + name + history); each invocation still runs in an independent provider session.
import type { Db } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import type { RoleId } from '../core/types.js';
import { roleDef } from './roles.js';
import type { AgentRow } from './store.js';

export class Team {
  constructor(private db: Db, private clock: Clock) {}

  /** Get an agent for a role, excluding given agent ids (independence), creating one if needed. */
  ensureAgent(projectId: string, role: RoleId, opts: { exclude?: string[]; responsibility?: string } = {}): AgentRow {
    const exclude = new Set(opts.exclude ?? []);
    const existing = this.db.all<AgentRow>("SELECT * FROM agents WHERE project_id=? AND role=? AND status != 'retired' ORDER BY activations ASC, created_at ASC", projectId, role);
    const pick = existing.find((a) => !exclude.has(a.id));
    if (pick) return pick;
    const def = roleDef(role, { responsibility: opts.responsibility });
    const base = role.replace(/_/g, '-');
    const now = this.clock.now();
    for (let n = existing.length + 1; n < existing.length + 50; n++) {
      const name = `${base}-${n}`;
      const r = this.db.run(
        `INSERT INTO agents(id, project_id, role, name, status, responsibility, created_at, updated_at) VALUES (?,?,?,?, 'idle', ?,?,?)
         ON CONFLICT(project_id, name) DO NOTHING`,
        newId('agt'), projectId, role, name, opts.responsibility ?? def.responsibility, now, now,
      );
      if (r.changes === 1) return this.db.get<AgentRow>('SELECT * FROM agents WHERE project_id=? AND name=?', projectId, name)!;
    }
    throw new Error(`could not allocate agent for role ${role}`);
  }

  /** Assemble the initial team from the plan (agents remain idle until work needs them). */
  assemble(projectId: string, team: Array<{ role: string; responsibility: string }>): AgentRow[] {
    const required: Array<{ role: string; responsibility?: string }> = [{ role: 'engineering_director' }, { role: 'code_reviewer' }, ...team];
    const seen = new Set<string>();
    const out: AgentRow[] = [];
    for (const m of required) {
      const role = m.role.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      if (!role || seen.has(role)) continue;
      seen.add(role);
      out.push(this.ensureAgent(projectId, role, { responsibility: m.responsibility }));
    }
    return out;
  }

  activate(agentId: string, taskId: string, provider: string): void {
    this.db.run("UPDATE agents SET status='active', current_task_id=?, last_provider=?, activations=activations+1, updated_at=? WHERE id=?", taskId, provider, this.clock.now(), agentId);
  }

  setStatus(agentId: string, status: AgentRow['status'], taskId: string | null = null): void {
    this.db.run('UPDATE agents SET status=?, current_task_id=?, updated_at=? WHERE id=?', status, taskId, this.clock.now(), agentId);
  }
}
