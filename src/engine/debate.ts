// Structured, bounded decision-making:
// propose → independent evaluation (prefer both providers) → rebuttal → final positions → owner decides.
// Max rounds is bounded; an extra round is allowed only for unresolved security-critical objections.
// The decision owner must document a resolution for every security-critical objection.
import { json } from '../core/db.js';
import { newId } from '../core/ids.js';
import type { ProjectRow, TaskRow } from '../core/types.js';
import type { Ctx } from './ctx.js';
import type { DecisionRow, Store } from './store.js';
import type { Team } from './team.js';

interface Position { agent_id: string; provider: string | null; round: number; phase: string; stance: string; summary: string; evidence: string; risks: string; objections: string }

export class DebateEngine {
  constructor(private ctx: Ctx, private store: Store, private team: Team) {}

  create(projectId: string, d: { key: string; title: string; problem: string; alternatives: string[] }): DecisionRow {
    const now = this.ctx.clock.now();
    this.ctx.db.run(
      `INSERT INTO decisions(id, project_id, key, title, problem, alternatives, status, max_rounds, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'proposing', ?,?,?) ON CONFLICT(project_id, key) DO NOTHING`,
      newId('dec'), projectId, d.key, d.title.slice(0, 300), d.problem.slice(0, 4000), JSON.stringify(d.alternatives), this.ctx.cfg.limits.maxDebateRounds, now, now,
    );
    return this.store.decisionByKey(projectId, d.key)!;
  }

  positions(decisionId: string): Position[] {
    return this.ctx.db.all<Position>('SELECT * FROM decision_positions WHERE decision_id=? ORDER BY created_at', decisionId);
  }

  private setStatus(d: DecisionRow, status: DecisionRow['status'], patch: Record<string, string | number | null> = {}): void {
    const keys = Object.keys(patch);
    this.ctx.db.run(`UPDATE decisions SET status=?, ${keys.map((k) => `${k}=?,`).join(' ')} updated_at=? WHERE id=?`, status, ...keys.map((k) => patch[k]!), this.ctx.clock.now(), d.id);
    this.ctx.events.emit('decision.status', `${d.key} → ${status}`, { projectId: d.project_id });
  }

  private evaluatorRoles(): string[] {
    return ['security_engineer', 'software_architect'];
  }

  /** Spawn whatever tasks the decision's current phase needs (idempotent). */
  advance(project: ProjectRow, d: DecisionRow): void {
    const q = this.ctx.queue;
    const base = { projectId: project.id, readOnly: true, complexity: 'high' as const, priority: 0 };
    switch (d.status) {
      case 'proposing': {
        const proposer = this.team.ensureAgent(project.id, 'software_architect');
        if (!d.proposer_agent_id) this.ctx.db.run('UPDATE decisions SET proposer_agent_id=? WHERE id=?', proposer.id, d.id);
        q.enqueue({ ...base, kind: 'debate_propose', role: 'software_architect', agentId: d.proposer_agent_id ?? proposer.id, idempotencyKey: `debate:${d.id}:propose`, input: { decisionId: d.id } });
        break;
      }
      case 'evaluating':
      case 'final_review': {
        const phase = d.status === 'evaluating' ? 'debate_evaluate' : 'debate_final';
        const proposerTask = q.byKey(`debate:${d.id}:propose`);
        this.evaluatorRoles().forEach((role, idx) => {
          const agent = this.team.ensureAgent(project.id, role, { exclude: d.proposer_agent_id ? [d.proposer_agent_id] : [] });
          // Prefer participation from both providers: the first evaluator avoids the proposer's provider.
          const exclude = idx === 0 && proposerTask?.provider ? [proposerTask.provider] : [];
          q.enqueue({ ...base, kind: phase, role, agentId: agent.id, excludeProviders: exclude, idempotencyKey: `debate:${d.id}:${phase}:r${d.round}:${role}`, input: { decisionId: d.id, round: d.round } });
        });
        break;
      }
      case 'rebutting':
        q.enqueue({ ...base, kind: 'debate_rebut', role: 'software_architect', agentId: d.proposer_agent_id, idempotencyKey: `debate:${d.id}:rebut:r${d.round}`, input: { decisionId: d.id, round: d.round } });
        break;
      case 'deciding': {
        const owner = this.team.ensureAgent(project.id, 'engineering_director');
        if (!d.owner_agent_id) this.ctx.db.run('UPDATE decisions SET owner_agent_id=? WHERE id=?', owner.id, d.id);
        const attempt = json<{ decideAttempt?: number }>(d.consequences, {}).decideAttempt ?? 0;
        q.enqueue({ ...base, kind: 'debate_decide', role: 'engineering_director', agentId: d.owner_agent_id ?? owner.id, idempotencyKey: `debate:${d.id}:decide:r${d.round}:a${attempt}`, input: { decisionId: d.id, round: d.round } });
        break;
      }
      default:
        break;
    }
  }

  /** Render the decision record for prompts (bounded). */
  render(d: DecisionRow): string {
    const pos = this.positions(d.id).map((p) => `- [r${p.round} ${p.phase}] ${p.stance} (${p.provider ?? '?'}): ${p.summary}\n  objections: ${json<Array<{ text: string; security_critical: boolean }>>(p.objections, []).map((o) => `${o.security_critical ? '[SECURITY] ' : ''}${o.text}`).join(' | ') || 'none'}`);
    return [`Key: ${d.key}`, `Title: ${d.title}`, `Problem: ${d.problem}`, `Alternatives considered: ${json<string[]>(d.alternatives, []).join('; ') || '(to be proposed)'}`,
      d.proposal ? `Proposal: ${d.proposal}` : '', pos.length ? `Positions:\n${pos.join('\n')}` : ''].filter(Boolean).join('\n').slice(0, 12_000);
  }

  unresolvedSecurityObjections(d: DecisionRow): string[] {
    const latest = new Map<string, Position>();
    for (const p of this.positions(d.id)) latest.set(p.agent_id, p);
    return [...latest.values()].flatMap((p) => json<Array<{ text: string; security_critical: boolean }>>(p.objections, []).filter((o) => o.security_critical).map((o) => o.text));
  }

  /** Apply a completed debate task's structured output and move the decision forward. */
  onResult(task: TaskRow, out: any): { decided?: DecisionRow; error?: string } {
    const input = json<{ decisionId: string; round?: number }>(task.input, { decisionId: '' });
    const d = this.store.decision(input.decisionId);
    if (!d) return { error: 'decision not found' };
    const now = this.ctx.clock.now();
    const savePos = (phase: string) => this.ctx.db.run(
      `INSERT INTO decision_positions(id, decision_id, agent_id, provider, round, phase, stance, summary, evidence, risks, objections, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_id, agent_id, round, phase) DO NOTHING`,
      newId('pos'), d.id, task.agent_id ?? 'unknown', task.provider, d.round, phase, out.stance, String(out.summary ?? '').slice(0, 3000),
      JSON.stringify(out.evidence ?? []), JSON.stringify(out.risks ?? []), JSON.stringify(out.objections ?? []), now,
    );
    const phaseDone = (phase: string) => {
      const n = this.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM decision_positions WHERE decision_id=? AND round=? AND phase=?', d.id, d.round, phase)!.n;
      return n >= this.evaluatorRoles().length;
    };
    switch (task.kind) {
      case 'debate_propose': {
        const alts = (out.alternatives ?? []).map((a: any) => `${a.name}: ${a.description} (+${(a.pros ?? []).join(', ')}; -${(a.cons ?? []).join(', ')})`);
        this.setStatus(d, 'evaluating', { alternatives: JSON.stringify(alts), proposal: `${out.recommendation} — ${out.rationale}`.slice(0, 4000), problem: String(out.problem || d.problem).slice(0, 4000) });
        break;
      }
      case 'debate_evaluate':
        savePos('evaluation');
        if (phaseDone('evaluation')) {
          const objections = this.positions(d.id).filter((p) => p.round === d.round).some((p) => p.stance !== 'support' && p.stance !== 'abstain' || json<unknown[]>(p.objections, []).length);
          this.setStatus(d, objections ? 'rebutting' : 'deciding');
        }
        break;
      case 'debate_rebut':
        this.setStatus(d, 'final_review', { proposal: `${out.proposal_summary}\nResponses: ${(out.responses ?? []).map((r: any) => `${r.objection} → ${r.response}`).join(' | ')}`.slice(0, 6000) });
        break;
      case 'debate_final':
        savePos('final');
        if (phaseDone('final')) {
          const sec = this.unresolvedSecurityObjections(d);
          if (sec.length && d.round < d.max_rounds + 1) {
            // One additional round is permitted only for unresolved security-critical objections.
            this.ctx.db.run('UPDATE decisions SET round=round+1 WHERE id=?', d.id);
            this.setStatus({ ...d, round: d.round + 1 }, 'rebutting');
          } else this.setStatus(d, 'deciding');
        }
        break;
      case 'debate_decide': {
        const sec = this.unresolvedSecurityObjections(d);
        const res = (out.security_resolutions ?? []) as Array<{ objection: string; resolution: string }>;
        const unresolved = sec.filter((o) => !res.some((r) => r.resolution?.trim() && (r.objection?.toLowerCase().includes(o.toLowerCase().slice(0, 30)) || o.toLowerCase().includes((r.objection ?? '').toLowerCase().slice(0, 30)))));
        if (unresolved.length) {
          const meta = json<{ decideAttempt?: number }>(d.consequences, {});
          const attempt = (meta.decideAttempt ?? 0) + 1;
          if (attempt >= 3) {
            this.setStatus(d, 'blocked', { rationale: `Security-critical objections lack documented resolution: ${unresolved.join(' | ')}`.slice(0, 4000) });
            return { error: 'unresolved security objections; decision blocked' };
          }
          this.ctx.db.run('UPDATE decisions SET consequences=? WHERE id=?', JSON.stringify({ decideAttempt: attempt, unresolved }), d.id);
          return { error: `decision must resolve security objections: ${unresolved.join(' | ')}` };
        }
        this.setStatus(d, 'decided', { outcome: String(out.outcome).slice(0, 2000), rationale: String(out.rationale).slice(0, 6000), consequences: JSON.stringify(out.consequences ?? []), security_resolutions: JSON.stringify(res) });
        const decided = this.store.decision(d.id)!;
        this.store.checkpoint({ projectId: d.project_id, kind: 'decision', summary: `${d.key} decided: ${decided.outcome}`, data: { adr: out.adr_markdown } });
        this.ctx.events.audit(`agent:${task.agent_id}`, 'decision.decided', { projectId: d.project_id, target: d.key, detail: { outcome: decided.outcome } });
        return { decided };
      }
    }
    return {};
  }

  adrMarkdown(d: DecisionRow, providedMd?: string): string {
    if (providedMd && providedMd.length > 80) return providedMd;
    const pos = this.positions(d.id);
    return `# ${d.key}: ${d.title}\n\nStatus: Accepted\n\n## Context\n${d.problem}\n\n## Options\n${json<string[]>(d.alternatives, []).map((a) => `- ${a}`).join('\n')}\n\n## Decision\n${d.outcome}\n\n## Rationale\n${d.rationale}\n\n## Consequences\n${json<string[]>(d.consequences, []).map((c) => `- ${c}`).join('\n')}\n\n## Review\n${pos.map((p) => `- ${p.phase} r${p.round} (${p.provider}): ${p.stance} — ${p.summary}`).join('\n')}\n`;
  }
}
