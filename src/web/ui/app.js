// Operator dashboard (vanilla JS, strict CSP). All agent/repository-derived text is rendered
// with textContent only: it is untrusted data and must never become markup.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const live = $('#live');
let pollTimer = null;
let lastRoute = '';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Orchestrator-CSRF': '1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { showLogin(); throw new Error('unauthenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');
const rel = (t) => {
  if (!t) return '—';
  const d = t - Date.now();
  const m = Math.round(Math.abs(d) / 60000);
  const s = m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return d >= 0 ? `in ${s}` : `${s} ago`;
};
const STATUS_CLASS = {
  completed: 's-ok', verified: 's-ok', done: 's-ok', merged: 's-ok', available: 's-ok', succeeded: 's-ok', pass: 's-ok', passed: 's-ok', decided: 's-ok', approved: 's-ok', published: 's-ok',
  active: 's-info', planning: 's-info', debating: 's-info', auditing: 's-info', releasing: 's-info', running: 's-info', implementing: 's-info', in_review: 's-info', gating: 's-info', implemented: 's-info', queued: 's-info', recovering: 's-warn',
  paused: 's-warn', waiting_capacity: 's-warn', waiting_message: 's-warn', throttled: 's-warn', exhausted: 's-warn', remediation: 's-warn', open: 's-warn', pending: 's-warn', fixed_claimed: 's-warn', medium: 's-warn',
  blocked: 's-bad', failed: 's-bad', dead: 's-bad', fail: 's-bad', error: 's-bad', auth_required: 's-bad', unavailable: 's-bad', disabled: 's-bad', critical: 's-bad', high: 's-bad', denied: 's-bad', stopped: 's-bad',
};
const badge = (s) => el('span', { class: `badge ${STATUS_CLASS[s] || 's-info'}` }, String(s ?? '—').replace(/_/g, ' '));

function table(caption, cols, rows, empty = 'Nothing yet.') {
  if (!rows.length) return el('div', { class: 'panel' }, el('h3', {}, caption), el('p', { class: 'muted' }, empty));
  return el('div', { class: 'panel table-wrap' }, el('table', {},
    el('caption', {}, caption),
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { scope: 'col' }, c.label)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, cols.map((c) => { const v = c.get(r); return el('td', { class: c.wrap ? 'wrap' : null }, v instanceof Node ? v : String(v ?? '—')); })))),
  ));
}

function confirmAction(title, body, label = 'Confirm', danger = false) {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  const ok = $('#confirm-ok');
  ok.textContent = label;
  ok.className = danger ? 'danger' : '';
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => { const v = d.returnValue; d.returnValue = ''; resolve(v === 'ok'); }, { once: true }));
}

function announce(msg) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }

function showLogin() {
  clearInterval(pollTimer);
  $('#login').hidden = false;
  view.replaceChildren();
  $('#logout').hidden = true;
  $('#token').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { token: $('#token').value } });
    $('#token').value = '';
    $('#login').hidden = true;
    $('#logout').hidden = false;
    route(true);
  } catch (err) { $('#login-error').textContent = err.message === 'unauthenticated' ? 'Invalid token.' : err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

// ------------------------------------------------------------------ views
async function renderOverview() {
  const o = await api('/api/overview');
  setApprovalCount(o.pendingApprovals);
  const cards = o.projects.map((p) => {
    const c = p.coverage;
    const wi = Object.fromEntries(p.workItems.map((x) => [x.status, x.n]));
    return el('article', { class: 'panel' },
      el('h3', {}, el('a', { href: `#/project/${p.id}` }, p.name), ' ', badge(p.status)),
      el('p', { class: 'muted' }, p.reason || ''),
      el('p', {}, `Verified requirements: ${c.verified} / ${c.mandatory} mandatory (${c.percentVerified}%)`),
      el('div', { class: 'progress', role: 'img', 'aria-label': `${c.percentVerified}% of mandatory requirements verified` }, el('span', { style: null, 'data-w': c.percentVerified })),
      el('p', { class: 'muted' }, `implemented ${c.implemented} · open ${c.open} · blocked ${c.blocked} · running agents ${p.runningTasks}`),
      el('p', { class: 'muted' }, Object.entries(wi).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || 'no work items yet'),
    );
  });
  view.replaceChildren(
    el('h2', {}, 'Projects'),
    o.projects.length ? el('div', { class: 'grid' }, cards) : el('div', { class: 'panel' }, el('p', {}, 'No projects yet. '), el('a', { href: '#/new' }, 'Start one from a goal.')),
    providerTable(o.providers),
  );
  for (const s of view.querySelectorAll('.progress > span')) s.style.width = `${Number(s.dataset.w)}%`;
}

function providerTable(ps) {
  return table('Providers', [
    { label: 'Provider', get: (p) => p.provider },
    { label: 'Status', get: (p) => badge(p.status) },
    { label: 'Reset', get: (p) => (p.resetAt ? `${rel(p.resetAt)} (${p.resetSource || 'unknown'})` : '—') },
    { label: 'Windows (provider-reported)', get: (p) => Object.values(p.windows || {}).map((w) => `${w.window}: ${w.utilization == null ? '?' : Math.round(w.utilization * 100) + '%'}${w.resetsAt ? ` resets ${rel(w.resetsAt)}` : ''}`).join('; ') || 'not exposed yet', wrap: true },
    { label: 'Running', get: (p) => `${p.running} / ${p.maxConcurrent}` },
    { label: 'Runs ok/failed', get: (p) => `${p.successes} / ${p.failures}` },
    { label: 'Tokens in/out (reported)', get: (p) => (p.usage && p.usage.sessions ? `${p.usage.input_tokens ?? '?'} / ${p.usage.output_tokens ?? '?'}` : '—') },
  ]);
}

async function renderProviders() {
  const ps = await api('/api/providers');
  const actions = el('div', { class: 'panel' }, el('h3', {}, 'Actions'),
    el('div', { class: 'actions' }, ps.map((p) => el('button', { type: 'button', class: 'ghost', onclick: async () => {
      if (!(await confirmAction(`Reset ${p.provider}?`, 'Marks the provider available again (use after re-authenticating). Usage limits are re-detected automatically.', 'Reset'))) return;
      await api(`/api/providers/${p.provider}/reset`, { method: 'POST' }); announce(`${p.provider} reset queued`);
    } }, `Reset ${p.provider}`))),
    el('form', { onsubmit: async (e) => { e.preventDefault(); const n = Number(new FormData(e.target).get('n')); await api('/api/config/concurrency', { method: 'POST', body: { maxConcurrentAgents: n } }); announce('Concurrency change queued'); } },
      el('label', { for: 'conc' }, 'Global maximum concurrent agents'), el('input', { id: 'conc', name: 'n', type: 'number', min: 1, max: 16, value: 2, required: true }),
      el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Apply'))));
  view.replaceChildren(el('h2', {}, 'Providers'), providerTable(ps), actions,
    el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Usage and cost figures are shown only when the provider reports them. Claude reports cost estimates; Codex reports tokens. Nothing is estimated by the orchestrator.')));
}

async function renderApprovals() {
  const rows = await api('/api/approvals');
  setApprovalCount(rows.filter((r) => r.status === 'pending').length);
  view.replaceChildren(el('h2', {}, 'Approvals'), table('Operator approvals', [
    { label: 'Requested', get: (a) => fmtTime(a.created_at) },
    { label: 'Action', get: (a) => a.action.replace(/_/g, ' ') },
    { label: 'Reason', get: (a) => a.reason, wrap: true },
    { label: 'Status', get: (a) => badge(a.status) },
    { label: 'Decide', get: (a) => a.status !== 'pending' ? (a.decided_by || '') : el('span', { class: 'actions' },
      el('button', { type: 'button', onclick: () => decide(a, true) }, 'Approve'),
      el('button', { type: 'button', class: 'ghost', onclick: () => decide(a, false) }, 'Deny')) },
  ], 'No approvals requested.'));
}

async function decide(a, approve) {
  if (!(await confirmAction(`${approve ? 'Approve' : 'Deny'}: ${a.action.replace(/_/g, ' ')}`, a.reason, approve ? 'Approve' : 'Deny', !approve))) return;
  await api(`/api/approvals/${a.id}/${approve ? 'approve' : 'deny'}`, { method: 'POST' });
  announce('Decision recorded');
  renderApprovals();
}

async function renderEvents() {
  const ev = await api('/api/events');
  view.replaceChildren(el('h2', {}, 'Activity'), eventsTable(ev));
}

const eventsTable = (ev) => table('Execution events (most recent first)', [
  { label: 'Time', get: (e) => fmtTime(e.ts) },
  { label: 'Level', get: (e) => badge(e.level === 'error' ? 'error' : e.level === 'warn' ? 'pending' : 'active') },
  { label: 'Type', get: (e) => el('code', {}, e.type) },
  { label: 'Message', get: (e) => e.message, wrap: true },
]);

function renderNew() {
  const form = el('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('/api/projects', { method: 'POST', body: { goal: fd.get('goal'), repo: fd.get('repo'), name: fd.get('name') || undefined, mode: fd.get('mode') } });
      announce('Project created'); location.hash = `#/project/${r.id}`;
    } catch (err) { $('#new-error').textContent = err.message; }
  } },
    el('label', { for: 'goal' }, 'Product goal (natural language, becomes an immutable baseline)'), el('textarea', { id: 'goal', name: 'goal', required: true }),
    el('label', { for: 'repo' }, 'Repository'), el('input', { id: 'repo', name: 'repo', required: true, placeholder: 'owner/name, a local git path, or "new"' }),
    el('label', { for: 'mode' }, 'Mode'), el('select', { id: 'mode', name: 'mode' }, el('option', { value: 'auto' }, 'Auto-detect'), el('option', { value: 'github' }, 'GitHub (issues, project board, PRs)'), el('option', { value: 'local' }, 'Local git only')),
    el('label', { for: 'pname' }, 'Name (optional)'), el('input', { id: 'pname', name: 'name' }),
    el('div', { class: 'actions' }, el('button', { type: 'submit' }, 'Start project')),
    el('p', { id: 'new-error', class: 'error', role: 'alert' }));
  view.replaceChildren(el('h2', {}, 'New project'), form);
}

const TABS = ['Requirements', 'Work items', 'Agents & tasks', 'Communications', 'Decisions', 'Reviews & defects', 'Quality gates', 'Releases', 'Usage', 'Activity'];
let currentTab = 'Requirements';

async function renderProject(id) {
  const [d, ev] = await Promise.all([api(`/api/projects/${id}`), api(`/api/events?project=${id}`)]);
  const p = d.project;
  const c = d.coverage;
  const ctl = (cmd, label, danger) => el('button', { type: 'button', class: danger ? 'danger' : 'ghost', onclick: async () => {
    if (!(await confirmAction(`${label} project?`, cmd === 'stop' ? 'Running agents are interrupted (their sessions remain resumable).' : `The supervisor will ${cmd} this project.`, label, danger))) return;
    await api(`/api/projects/${id}/${cmd}`, { method: 'POST' }); announce(`${label} queued`);
  } }, label);
  const head = el('div', { class: 'panel' },
    el('h2', {}, p.name, ' ', badge(p.status)),
    el('p', { class: 'muted' }, p.status_reason || ''),
    el('dl', { class: 'kv' },
      el('dt', {}, 'Repository'), el('dd', {}, `${p.repo_mode}: ${p.repo_source || '(new local repository)'}`),
      el('dt', {}, 'Verified'), el('dd', {}, `${c.verified} of ${c.mandatory} mandatory requirements (${c.percentVerified}%) · implemented ${c.implemented} · blocked ${c.blocked}`),
      el('dt', {}, 'Gates'), el('dd', {}, (p.settings.gates || []).map((g) => `${g.name}: ${g.command}`).join(' · ') || 'not yet planned'),
      el('dt', {}, 'Goal SHA-256'), el('dd', { class: 'mono' }, p.goal_sha256)),
    el('details', {}, el('summary', {}, 'Original goal (immutable)'), el('pre', {}, p.goal_text)),
    el('div', { class: 'actions' }, ctl('pause', 'Pause'), ctl('resume', 'Resume'), ctl('stop', 'Stop', true)),
    d.approvals.length ? el('p', { class: 's-warn' }, `${d.approvals.length} approval(s) waiting — `, el('a', { href: '#/approvals' }, 'review')) : null);
  const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Project sections' }, TABS.map((t) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': t === currentTab ? 'true' : 'false', 'aria-controls': 'tabpanel', id: `tab-${t}`,
    onclick: () => { currentTab = t; renderProject(id); },
  }, t)));
  tabs.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const i = TABS.indexOf(currentTab);
    currentTab = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    renderProject(id).then(() => document.getElementById(`tab-${currentTab}`)?.focus());
  });
  const wiKey = Object.fromEntries(d.workItems.map((w) => [w.id, w.key]));
  const agentName = Object.fromEntries(d.agents.map((a) => [a.id, a.name]));
  const gh = Object.fromEntries(d.github.map((g) => [`${g.kind}:${g.key}`, g]));
  const ghLink = (kind, key) => { const g = gh[`${kind}:${key}`]; return g && g.url ? el('a', { href: g.url, rel: 'noopener noreferrer', target: '_blank' }, `#${g.number}`) : '—'; };
  const panels = {
    'Requirements': () => table('Requirements (progress is computed from verified requirements)', [
      { label: 'Key', get: (r) => r.key }, { label: 'Title', get: (r) => r.title, wrap: true }, { label: 'Kind', get: (r) => r.kind },
      { label: 'Mandatory', get: (r) => (r.mandatory ? 'yes' : 'no') }, { label: 'Status', get: (r) => badge(r.status) },
      { label: 'Evidence', get: (r) => r.evidence.map((e) => Object.entries(e).map(([k, v]) => `${k}: ${v}`).join(', ')).join('\n') || (r.blocker ? `BLOCKER: ${r.blocker}` : '—'), wrap: true },
      { label: 'Issue', get: (r) => ghLink('requirement', r.key) },
    ]),
    'Work items': () => table('Work items', [
      { label: 'Key', get: (w) => w.key }, { label: 'Title', get: (w) => w.title, wrap: true }, { label: 'Role', get: (w) => w.role },
      { label: 'Status', get: (w) => badge(w.status) }, { label: 'Depends on', get: (w) => w.depends_on.join(', ') || '—' },
      { label: 'Implementer', get: (w) => `${agentName[w.implementer_agent_id] || '—'}${w.implementer_provider ? ` @ ${w.implementer_provider}` : ''}` },
      { label: 'Commit (head/reviewed/merged)', get: (w) => [w.head_commit, w.reviewed_commit, w.merged_commit].map((x) => (x ? x.slice(0, 8) : '·')).join(' / ') },
      { label: 'Note', get: (w) => w.status_reason || '', wrap: true }, { label: 'Issue / PR', get: (w) => el('span', {}, ghLink('work-item', w.key), ' ', ghLink('pr', w.key)) },
    ]),
    'Agents & tasks': () => el('div', {}, table('Team', [
      { label: 'Agent', get: (a) => a.name }, { label: 'Role', get: (a) => a.role }, { label: 'Status', get: (a) => badge(a.status) },
      { label: 'Responsibility', get: (a) => a.responsibility, wrap: true }, { label: 'Activations', get: (a) => a.activations }, { label: 'Last provider', get: (a) => a.last_provider || '—' },
    ]), table('Tasks (most recent first)', [
      { label: 'Updated', get: (t) => fmtTime(t.updated_at) }, { label: 'Kind', get: (t) => t.kind }, { label: 'Work item', get: (t) => wiKey[t.work_item_id] || '—' },
      { label: 'Agent', get: (t) => agentName[t.agent_id] || t.role }, { label: 'Provider', get: (t) => t.provider || '—' }, { label: 'Status', get: (t) => badge(t.status) },
      { label: 'Attempts', get: (t) => t.attempts }, { label: 'Session', get: (t) => (t.session_id ? el('code', {}, t.session_id.slice(0, 13)) : '—') },
      { label: 'Last error', get: (t) => (t.error_class ? `${t.error_class}: ${(t.error_message || '').slice(0, 200)}` : ''), wrap: true },
    ])),
    'Communications': () => table('Agent messages', [
      { label: 'Time', get: (m) => fmtTime(m.created_at) }, { label: 'From', get: (m) => agentName[m.sender_agent_id] || m.sender_agent_id },
      { label: 'To', get: (m) => agentName[m.recipient_agent_id] || m.recipient_role || '—' }, { label: 'Type', get: (m) => m.type },
      { label: 'Blocking', get: (m) => (m.blocking ? 'yes' : 'no') }, { label: 'State', get: (m) => badge(m.state) }, { label: 'Message', get: (m) => m.body, wrap: true },
    ], 'No inter-agent messages yet.'),
    'Decisions': () => el('div', {}, d.decisions.length ? d.decisions.map((x) => el('div', { class: 'panel' },
      el('h3', {}, `${x.key}: ${x.title} `, badge(x.status)), el('p', {}, x.problem), x.outcome ? el('p', {}, el('strong', {}, 'Outcome: '), x.outcome) : null,
      x.rationale ? el('p', { class: 'muted' }, x.rationale) : null,
      table('Positions', [{ label: 'Round', get: (q) => q.round }, { label: 'Phase', get: (q) => q.phase }, { label: 'Agent', get: (q) => agentName[q.agent_id] || q.agent_id },
        { label: 'Provider', get: (q) => q.provider }, { label: 'Stance', get: (q) => q.stance }, { label: 'Summary', get: (q) => q.summary, wrap: true }], 'No positions yet.'))) : el('p', { class: 'muted panel' }, 'No material decisions required debate.')),
    'Reviews & defects': () => table('Review findings', [
      { label: 'Severity', get: (f) => badge(f.severity) }, { label: 'Work item', get: (f) => wiKey[f.work_item_id] || '—' }, { label: 'Title', get: (f) => f.title, wrap: true },
      { label: 'Reviewer', get: (f) => `${agentName[f.reviewer_agent_id] || '—'} @ ${f.reviewer_provider || '?'}` }, { label: 'Status', get: (f) => badge(f.status) },
      { label: 'Evidence', get: (f) => f.evidence, wrap: true }, { label: 'Resolution evidence', get: (f) => f.resolution_evidence || '', wrap: true },
    ], 'No findings recorded.'),
    'Quality gates': () => el('div', {}, table('Gate runs (actual command exit codes)', [
      { label: 'Time', get: (g) => fmtTime(g.started_at) }, { label: 'Scope', get: (g) => g.scope }, { label: 'Work item', get: (g) => wiKey[g.work_item_id] || '—' },
      { label: 'Commit', get: (g) => el('code', {}, g.commit_sha.slice(0, 8)) }, { label: 'Gate', get: (g) => g.name }, { label: 'Command', get: (g) => el('code', {}, g.command) },
      { label: 'Result', get: (g) => badge(g.status) }, { label: 'Exit', get: (g) => g.exit_code }, { label: 'Duration', get: (g) => `${Math.round((g.duration_ms || 0) / 100) / 10}s` },
    ]), table('Audits', [{ label: 'Kind', get: (a) => a.kind }, { label: 'Round', get: (a) => a.round }, { label: 'Commit', get: (a) => (a.commit_sha || '').slice(0, 8) }, { label: 'Status', get: (a) => badge(a.status) }, { label: 'Result', get: (a) => a.result, wrap: true }])),
    'Releases': () => table('Releases', [
      { label: 'Version', get: (r) => r.version }, { label: 'Commit', get: (r) => el('code', {}, r.commit_sha.slice(0, 10)) }, { label: 'Status', get: (r) => badge(r.status) },
      { label: 'SHA-256', get: (r) => el('code', {}, r.sha256 || '—') },
      { label: 'Download', get: (r) => (['verified', 'published'].includes(r.status) ? el('a', { href: `/api/releases/${r.id}/download`, download: '' }, 'ZIP') : '—') },
      { label: 'GitHub', get: (r) => (r.github_release_url ? el('a', { href: r.github_release_url, rel: 'noopener noreferrer', target: '_blank' }, 'release') : '—') },
    ], 'No release yet. Releases are produced only after a passing independent completion audit.'),
    'Usage': () => el('div', {}, table('Provider-reported usage', [
      { label: 'Provider', get: (u) => u.provider }, { label: 'Model', get: (u) => u.model || 'default' }, { label: 'Runs', get: (u) => u.runs },
      { label: 'Input tokens', get: (u) => u.input_tokens ?? 'not reported' }, { label: 'Cached', get: (u) => u.cached_tokens ?? '—' }, { label: 'Output tokens', get: (u) => u.output_tokens ?? 'not reported' },
      { label: 'Cost (provider estimate)', get: (u) => (u.reported_cost_usd == null ? 'not reported' : `$${Number(u.reported_cost_usd).toFixed(4)}`) },
    ]), table('Context efficiency (prompt size per invocation)', [
      { label: 'Task kind', get: (x) => x.kind }, { label: 'Session mode', get: (x) => x.mode }, { label: 'Runs', get: (x) => x.runs },
      { label: 'Avg prompt chars', get: (x) => x.avg_prompt_chars }, { label: 'Max prompt chars', get: (x) => x.max_prompt_chars },
    ])),
    'Activity': () => eventsTable(ev),
  };
  view.replaceChildren(head, tabs, el('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${currentTab}` }, panels[currentTab]()));
}

function setApprovalCount(n) {
  const b = $('#approval-count');
  b.hidden = !n;
  b.textContent = n ? String(n) : '';
  b.setAttribute('aria-label', `${n} pending`);
}

async function route(force = false) {
  const h = location.hash || '#/';
  for (const a of document.querySelectorAll('.top nav a')) a.setAttribute('aria-current', a.getAttribute('href') === h ? 'page' : 'false');
  const changed = h !== lastRoute;
  lastRoute = h;
  try {
    if (h.startsWith('#/project/')) await renderProject(h.slice('#/project/'.length));
    else if (h === '#/providers') await renderProviders();
    else if (h === '#/approvals') await renderApprovals();
    else if (h === '#/events') await renderEvents();
    else if (h === '#/new') { if (changed || force) renderNew(); }
    else await renderOverview();
    $('#login').hidden = true;
    $('#logout').hidden = false;
    if (changed) $('#main').focus();
  } catch (e) {
    if (e.message !== 'unauthenticated') view.replaceChildren(el('p', { class: 'error', role: 'alert' }, `Error: ${e.message}`));
    return;
  }
  clearInterval(pollTimer);
  // Poll while the tab is visible; forms are never re-rendered under the user.
  pollTimer = setInterval(() => { if (!document.hidden && location.hash !== '#/new' && !$('#confirm').open) route(); }, 5000);
}

window.addEventListener('hashchange', () => route(true));
route(true);
