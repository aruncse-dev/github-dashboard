import {
  GitHubError, forgetToken, getToken, isFineGrained, probe, rest, saveToken, setWarningHandler, storage,
  type MergeMethod, type RestFile, type RestPull, type ReviewEvent,
} from './api';
import {
  checkBucket, fetchCheckRunDetail, fetchLabels, fetchMergeSettings, fetchPullRequest, fetchPullRequestDetail, fetchRecentRepos, fetchViewer, searchRepos, tokenRepos, searchPullRequests, summarizeChecks,
  type CheckBucket, type CheckRunDetail, type DetailCheck, type PullRequest, type PullRequestDetail, type Repo, type Viewer,
} from './queries';
import {
  $, closeDialog, diffstat, esc, hydrateIcons, icon, initDialogs, isDialogOpen, openDialog, renderPatch, safeUrl, timeAgo, toast, withBusy,
} from './ui';
import { favorites } from './favorites';
import { checkToken, type Requirement } from './tokencheck';
import { actionsBucket, actionsForCommit, actionsText, runsByCommit, type Job, type WorkflowRun } from './actions';
import type { CheckSummary } from './queries';
import { cache } from './cache';
import { hasIncompleteQualifier, initSuggest, rememberSearch } from './suggest';

// ---------- State ----------

type Tab = 'open' | 'closed';

const LAST_KEY = 'gh_pr_last_v3';
storage.remove('gh_pr_last_v2'); // may point at the personal account before org discovery improved
const THEME_KEY = 'gh_pr_theme';

const state = {
  viewer: null as Viewer | null,
  owner: '',
  repo: '',
  tab: 'open' as Tab,
  chip: '',
  query: '',
  prs: [] as PullRequest[],
  cursor: null as string | null,
  hasMore: false,
  counts: { open: 0, closed: 0 },
  loadSeq: 0,
  current: null as PullRequest | null,
  /** GitHub Actions runs by commit, for fine-grained tokens (they can't read check runs). */
  runs: null as Map<string, WorkflowRun[]> | null,
};

const CHIP_QUALIFIERS: Record<string, string> = {
  requested: 'review-requested:@me',
  mine: 'author:@me',
  ready: 'review:approved status:success draft:false',
  pending: 'review:required draft:false',
  changes: 'review:changes_requested',
  failing: 'status:failure',
};

function saveLast(): void {
  storage.set(LAST_KEY, JSON.stringify({ owner: state.owner, repo: state.repo }));
}
function readLast(): { owner?: string; repo?: string } {
  try { return JSON.parse(storage.get(LAST_KEY) ?? '{}'); } catch { return {}; }
}

const ownerOf = (pr: PullRequest) => pr.repository.owner.login;
const repoOf = (pr: PullRequest) => pr.repository.name;

// ---------- Boot / auth ----------

function showLogin(message = ''): void {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#tokenCheck').classList.add('hidden');
  $('#loginContinue').classList.add('hidden');
  setLoginMessage(message);
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => $('#token').focus(), 50);
}

function setLoginMessage(message: string, kind: 'error' | 'warn' = 'error'): void {
  const el = $('#loginError');
  el.textContent = message;
  el.classList.toggle('warn', kind === 'warn');
  el.classList.toggle('hidden', !message);
}

const REQ_ICON: Record<Requirement['status'], string> = {
  pass: icon('check', 'c-pass'),
  fail: icon('x', 'c-fail'),
  warn: icon('alert', 'c-pending'),
  info: icon('dot', 'c-muted'),
  running: '<span class="spinner" style="width:14px;height:14px"></span>',
};

function renderTokenCheck(items: Requirement[]): void {
  const box = $('#tokenCheck');
  box.classList.remove('hidden');
  box.innerHTML = items.map((i) => `
    <div class="d-row">${REQ_ICON[i.status]}
      <span class="d-grow"><b>${esc(i.label)}</b><small class="diag-detail">${esc(i.detail)}</small>
        ${i.fix && (i.status === 'fail' || i.status === 'warn') ? `<span class="fix">→ ${esc(i.fix)}</span>` : ''}</span>
    </div>`).join('');
}

async function boot(): Promise<void> {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#list').innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
  try {
    // Org list comes from the local cache; "Sync" in the org picker refreshes it.
    const cached = cache.viewer();
    if (cached) state.viewer = cached.data;
    else {
      state.viewer = await fetchViewer();
      cache.setViewer(state.viewer);
    }
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) {
      forgetToken();
      return showLogin('Saved token no longer works. Please sign in again.');
    }
    return showListError(e);
  }
  const me = state.viewer;
  const img = $<HTMLImageElement>('#meAvatar');
  img.src = me.avatarUrl;
  img.title = me.login;

  // Default: last used org/repo, else first favourite org, else first org (or personal account).
  const last = readLast();
  state.owner = last.owner || favorites.orgs()[0] || me.organizations.nodes[0]?.login || me.login;
  state.repo = last.owner === state.owner && last.repo ? last.repo : await defaultRepo(state.owner);
  saveLast();
  await loadPrs(true);
}

/** First favourite repo of the owner, else its most recently pushed repo. */
async function defaultRepo(owner: string): Promise<string> {
  const fav = favorites.repos(owner)[0];
  if (fav) return fav;
  const cached = cache.repos(owner);
  if (cached?.data.length) return cached.data[0].name;
  try {
    const recent = await fetchRecentRepos(owner);
    cache.setRepos(owner, recent);
    return recent[0]?.name ?? '';
  } catch (e) {
    showListError(e);
    return '';
  }
}

async function selectOwner(owner: string): Promise<void> {
  state.owner = owner;
  state.repo = '';
  state.prs = [];
  updateHeader();
  $('#repoBtnLabel').textContent = '…';
  $('#list').innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
  const repo = await defaultRepo(owner);
  if (state.owner !== owner) return; // user switched again meanwhile
  state.repo = repo;
  saveLast();
  await loadPrs(true);
}

// ---------- PR list ----------

function searchScope(): string {
  const parts = [state.repo ? `repo:${state.owner}/${state.repo}` : `user:${state.owner}`];
  if (state.chip) parts.push(CHIP_QUALIFIERS[state.chip]);
  // "#123" → "123" so GitHub matches the PR number.
  if (state.query) parts.push(state.query.replace(/(^|\s)#(\d+)\b/g, '$1$2'));
  return parts.join(' ');
}

async function loadPrs(reset: boolean): Promise<void> {
  const seq = ++state.loadSeq;
  if (reset) {
    $('#q').dispatchEvent(new Event('suggest:reset'));
    state.cursor = null;
    $('#list').innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
    $('#moreWrap').classList.add('hidden');
  }
  $('#listError').classList.add('hidden');
  updateHeader();
  try {
    const res = await searchPullRequests(searchScope(), state.tab, reset ? null : state.cursor);
    if (seq !== state.loadSeq) return; // a newer request superseded this one
    state.prs = reset ? res.prs : [...state.prs, ...res.prs];
    state.cursor = res.endCursor;
    state.hasMore = res.hasNextPage;
    state.counts = { open: res.openCount, closed: res.closedCount };
    renderList();
    if (reset && isFineGrained()) void loadRuns(seq);
  } catch (e) {
    if (seq !== state.loadSeq) return;
    if (e instanceof GitHubError && e.status === 401) {
      forgetToken();
      return showLogin('Saved token no longer works. Please sign in again.');
    }
    if (reset) $('#list').innerHTML = '';
    showListError(e);
  }
}

/** One request for the repo's recent Actions runs; cards then show their CI status. */
async function loadRuns(seq: number): Promise<void> {
  state.runs = null;
  if (!state.repo) return;
  try {
    const runs = await runsByCommit(state.owner, state.repo);
    if (seq !== state.loadSeq) return;
    state.runs = runs;
    renderList();
  } catch {
    /* no "Actions: Read": cards show commit statuses only */
  }
}

/** Check summary for a card: GraphQL rollup, plus Actions runs when check runs are unreadable. */
function ciSummary(pr: PullRequest): CheckSummary {
  const s = summarizeChecks(pr);
  const sha = pr.commits.nodes[0]?.commit.oid;
  const runs = sha ? state.runs?.get(sha) : undefined;
  if (!runs?.length || s.items.some((i) => i.fromCheckRun)) return s;
  for (const r of runs) {
    const bucket = actionsBucket(r.status, r.conclusion);
    s[bucket]++;
    s.total++;
    s.items.push({ name: r.name ?? 'workflow', url: r.html_url, bucket, fromCheckRun: true });
  }
  s.overall = s.fail ? 'fail' : s.pending ? 'pending' : s.pass ? 'pass' : 'none';
  return s;
}

function showListError(e: unknown): void {
  const box = $('#listError');
  box.textContent = e instanceof Error ? e.message : String(e);
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.style.marginTop = '8px';
  btn.dataset.diag = '';
  btn.textContent = 'Check token access';
  box.append(document.createElement('br'), btn);
  box.classList.remove('hidden');
}

function updateHeader(): void {
  $('#ownerBtnLabel').textContent = state.owner;
  const me = state.viewer;
  const avatar = me?.login.toLowerCase() === state.owner.toLowerCase() ? me.avatarUrl
    : me?.organizations.nodes.find((o) => o.login.toLowerCase() === state.owner.toLowerCase())?.avatarUrl;
  const img = $<HTMLImageElement>('#ownerAvatar');
  if (avatar) img.src = avatar;
  img.classList.toggle('hidden', !avatar);
  $('#repoBtnLabel').textContent = state.repo || 'Select…';
  document.querySelectorAll<HTMLElement>('.seg [data-tab]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab)));
}

function renderList(): void {
  $('#openCount').textContent = String(state.counts.open);
  $('#closedCount').textContent = String(state.counts.closed);
  $('#moreWrap').classList.toggle('hidden', !state.hasMore);
  $('#list').innerHTML = state.prs.length
    ? state.prs.map(prCard).join('')
    : `<div class="blankslate">${icon(state.tab === 'open' ? 'open' : 'check')}
         <h3>No ${state.tab} pull requests</h3><p>Nothing matches the current filters.</p>
         <button class="btn btn-sm" data-diag>Expected some? Check token access</button></div>`;
}

function stateIcon(pr: PullRequest): string {
  if (pr.state === 'MERGED') return icon('merged', 'c-merged');
  if (pr.state === 'CLOSED') return icon('closed', 'c-closed');
  return pr.isDraft ? icon('draft', 'c-draft') : icon('open', 'c-open');
}

function reviewLabel(pr: PullRequest): string {
  if (pr.state === 'MERGED') return '<span class="Label Label--done">Merged</span>';
  if (pr.state === 'CLOSED') return '<span class="Label Label--danger">Closed</span>';
  if (pr.isDraft) return '<span class="Label">Draft</span>';
  switch (pr.reviewDecision) {
    case 'APPROVED': return `<span class="Label Label--success">${icon('check')} Approved</span>`;
    case 'CHANGES_REQUESTED': return `<span class="Label Label--danger">${icon('x')} Changes requested</span>`;
    // "Review required" is the normal state of an open PR: not worth a label.
    default: return '';
  }
}

/** Compact checks status for cards: icon + count; tap opens the checks in PR details. */
function checksStatus(pr: PullRequest): string {
  const s = ciSummary(pr);
  if (s.overall === 'none') return '';
  const attrs = `type="button" class="st" data-act="details" data-section="checks" data-id="${esc(pr.id)}"`;
  if (s.overall === 'fail') return `<button ${attrs} title="${s.fail} of ${s.total} checks failed" aria-label="${s.fail} of ${s.total} checks failed"><span class="c-fail">${icon('x')}${s.fail}/${s.total}</span></button>`;
  if (s.overall === 'pending') return `<button ${attrs} title="${s.pending} of ${s.total} checks running" aria-label="${s.pending} of ${s.total} checks running"><span class="c-pending">${icon('dot', 'pulse')}${s.pending}/${s.total}</span></button>`;
  return `<button ${attrs} title="${s.pass} of ${s.total} checks passed" aria-label="${s.pass} of ${s.total} checks passed"><span class="c-pass">${icon('check')}${s.pass}/${s.total}</span></button>`;
}

/** Compact review status for cards. */
function reviewStatus(pr: PullRequest, myReview: string | undefined): string {
  if (pr.state === 'MERGED') return `<span class="st c-merged">${icon('merged')}Merged</span>`;
  if (pr.state === 'CLOSED') return `<span class="st c-closed">${icon('closed')}Closed</span>`;
  if (pr.isDraft) return `<span class="st c-muted">${icon('draft')}Draft</span>`;
  if (myReview === 'APPROVED' && !isMine(pr)) return `<span class="st c-pass" title="You approved this">${icon('check')}Approved</span>`;
  if (pr.reviewDecision === 'APPROVED') return `<span class="st c-pass">${icon('check')}Approved</span>`;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return `<span class="st c-fail">${icon('x')}Changes</span>`;
  return '';
}

const WRITE_PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE'];

const isMine = (pr: PullRequest) => !!state.viewer && pr.author?.login === state.viewer.login;
/** GitHub never lets you approve or request changes on your own pull request. */
const canReview = (pr: PullRequest) => pr.state === 'OPEN' && !isMine(pr);
/** Unknown permission (null) still shows Merge; GitHub has the final say. */
const canMerge = (pr: PullRequest) =>
  pr.state === 'OPEN' && !pr.isDraft &&
  (pr.repository.viewerPermission === null || WRITE_PERMISSIONS.includes(pr.repository.viewerPermission));

function prCard(pr: PullRequest): string {
  const id = esc(pr.id);
  const isOpen = pr.state === 'OPEN';
  const when = pr.state === 'MERGED' && pr.mergedAt ? `merged ${timeAgo(pr.mergedAt, true)}`
    : pr.state === 'CLOSED' && pr.closedAt ? `closed ${timeAgo(pr.closedAt, true)}`
    : timeAgo(pr.createdAt, true);
  const author = pr.author?.login ?? 'ghost';
  const myReview = pr.viewerLatestReview?.state;

  const status = [
    isOpen ? checksStatus(pr) : '',
    reviewStatus(pr, myReview),
    isOpen && pr.mergeable === 'CONFLICTING' ? `<span class="st c-pending" title="Has merge conflicts" aria-label="Has merge conflicts">${icon('alert')}</span>` : '',
  ].join('');

  const actions = [
    `<button class="btn btn-icon" data-act="files" data-id="${id}" title="Files changed" aria-label="Files changed">${icon('diff')}</button>`,
    canReview(pr) ? `<button class="btn" data-act="review" data-id="${id}">${icon('comment')}Review</button>` : '',
    canMerge(pr) ? `<button class="btn btn-primary" data-act="merge" data-id="${id}">${icon('merged')}Merge</button>` : '',
  ].join('');

  return `
    <article class="pr" data-id="${id}" tabindex="0" aria-label="Pull request #${pr.number}: ${esc(pr.title)}">
      <div class="pr-top">
        ${stateIcon(pr)}
        <span class="ref">#${pr.number}</span>
        <span class="dot">·</span><span class="who">${isMine(pr) ? '<b>you</b>' : esc(author)}</span>
        <span class="dot">·</span><span class="when">${esc(when)}</span>
        <span class="spacer"></span>
        ${pr.comments.totalCount ? `<span class="comments" title="Comments">${icon('comment')}${pr.comments.totalCount}</span>` : ''}
      </div>
      <div class="pr-title">${esc(pr.title)}</div>
      <div class="pr-foot">
        <div class="pr-status">${status}</div>
        <div class="pr-actions">${actions}</div>
      </div>
    </article>`;
}

/** Re-fetches one PR after an action and updates (or drops) its card. */
async function refreshOne(pr: PullRequest): Promise<void> {
  try {
    const fresh = await fetchPullRequest(pr.id);
    const i = state.prs.findIndex((p) => p.id === pr.id);
    if (!fresh || i < 0) return;
    const belongs = state.tab === 'open' ? fresh.state === 'OPEN' : fresh.state !== 'OPEN';
    if (belongs) state.prs[i] = fresh;
    else {
      state.prs.splice(i, 1);
      state.counts.open--;
      state.counts.closed++;
    }
    renderList();
  } catch {
    void loadPrs(true);
  }
  if (detail.pr?.id === pr.id && isDialogOpen('#detailSheet')) void loadDetails();
}

// ---------- PR details (tap a card) ----------

type RunState = CheckRunDetail | 'loading' | { error: string };

const detail = {
  pr: null as PullRequest | null,
  data: null as PullRequestDetail | null,
  error: '',
  loading: false,
  timer: 0,
  expanded: new Set<string>(),
  runs: new Map<string, RunState>(),
  showFullBody: false,
  /** GitHub Actions jobs for the head commit (fine-grained tokens can't read check runs). */
  actions: null as { loading: boolean; error: string; runs: WorkflowRun[]; jobs: Job[] } | null,
};

const AUTO_REFRESH_MS = 15000;

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function checkStatus(c: DetailCheck): { bucket: CheckBucket; text: string; time: string } {
  const bucket = checkBucket(c);
  if (c.__typename === 'StatusContext') {
    const text = ({ SUCCESS: 'Passed', FAILURE: 'Failed', ERROR: 'Error', PENDING: 'Pending', EXPECTED: 'Expected' } as Record<string, string>)[c.state ?? ''] ?? c.state ?? '';
    return { bucket, text, time: c.createdAt ? timeAgo(c.createdAt, true) : '' };
  }
  const text = c.status !== 'COMPLETED'
    ? ({ QUEUED: 'Queued', IN_PROGRESS: 'Running', WAITING: 'Waiting', PENDING: 'Pending', REQUESTED: 'Requested' } as Record<string, string>)[c.status ?? ''] ?? 'Pending'
    : ({ SUCCESS: 'Passed', FAILURE: 'Failed', NEUTRAL: 'Neutral', CANCELLED: 'Cancelled', SKIPPED: 'Skipped', TIMED_OUT: 'Timed out',
        ACTION_REQUIRED: 'Action required', STALE: 'Stale', STARTUP_FAILURE: 'Startup failure' } as Record<string, string>)[c.conclusion ?? ''] ?? 'Done';
  let time = '';
  if (c.startedAt && c.status !== 'QUEUED') {
    const end = c.completedAt ? Date.parse(c.completedAt) : Date.now();
    time = formatDuration(end - Date.parse(c.startedAt));
    if (!c.completedAt) time = `for ${time}`;
  }
  return { bucket, text, time };
}

const BUCKET_ICON: Record<CheckBucket, string> = {
  pass: icon('check', 'c-pass'),
  fail: icon('x', 'c-fail'),
  pending: icon('dot', 'c-pending pulse'),
  skipped: icon('skip', 'c-skipped'),
};

function detailChecks(d: PullRequestDetail): DetailCheck[] {
  const order: Record<CheckBucket, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
  const nodes = d.checks.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const name = (c: DetailCheck) => (c.__typename === 'CheckRun' ? c.name : c.context) ?? '';
  return [...nodes].sort((a, b) => order[checkBucket(a)] - order[checkBucket(b)] || name(a).localeCompare(name(b)));
}

const hasCheckRuns = (d: PullRequestDetail) => detailChecks(d).some((c) => c.__typename === 'CheckRun');
const hasPendingChecks = (d: PullRequestDetail) =>
  detailChecks(d).some((c) => checkBucket(c) === 'pending') ||
  !!detail.actions?.jobs.some((j) => actionsBucket(j.status, j.conclusion) === 'pending');

async function loadActions(d: PullRequestDetail): Promise<void> {
  const sha = d.commits.nodes[0]?.commit.oid;
  if (!sha) return;
  detail.actions = { loading: true, error: '', runs: detail.actions?.runs ?? [], jobs: detail.actions?.jobs ?? [] };
  try {
    const { runs, jobs } = await actionsForCommit(ownerOf(d), repoOf(d), sha);
    detail.actions = { loading: false, error: '', runs, jobs };
  } catch (e) {
    const forbidden = e instanceof GitHubError && (e.status === 403 || e.status === 404);
    detail.actions = { loading: false, runs: [], jobs: [],
      error: forbidden ? 'GitHub Actions results need “Actions: Read” on the token.' : (e as Error).message };
  }
}

async function openDetails(pr: PullRequest, focus?: string): Promise<void> {
  if (detail.pr?.id !== pr.id) {
    detail.data = null;
    detail.actions = null;
    detail.expanded.clear();
    detail.runs.clear();
    detail.showFullBody = false;
  }
  detail.pr = pr;
  detail.error = '';
  renderDetails();
  openDialog('#detailSheet');
  $('#detailBody').scrollTop = 0;
  await loadDetails(focus);
}

async function loadDetails(focus?: string): Promise<void> {
  const pr = detail.pr;
  if (!pr) return;
  clearTimeout(detail.timer);
  detail.loading = true;
  document.getElementById('detailRefresh')?.classList.add('spinning');
  try {
    const d = await fetchPullRequestDetail(pr.id);
    if (detail.pr?.id !== pr.id) return;
    detail.data = d;
    detail.error = d ? '' : 'Pull request not found.';
    if (d && !hasCheckRuns(d)) {
      renderDetails();
      await loadActions(d);
      if (detail.pr?.id !== pr.id) return;
    }
  } catch (e) {
    if (detail.pr?.id !== pr.id) return;
    detail.error = (e as Error).message;
  }
  detail.loading = false;
  renderDetails();
  if (focus === 'checks') document.getElementById('detailChecks')?.scrollIntoView({ block: 'start' });
  // Keep running checks fresh while the sheet stays open.
  if (detail.data && hasPendingChecks(detail.data) && isDialogOpen('#detailSheet')) {
    detail.timer = window.setTimeout(() => {
      if (isDialogOpen('#detailSheet') && detail.pr?.id === pr.id) void loadDetails();
    }, AUTO_REFRESH_MS);
  }
}

function statePill(pr: PullRequest): string {
  if (pr.state === 'MERGED') return `<span class="State State--merged">${icon('merged')} Merged</span>`;
  if (pr.state === 'CLOSED') return `<span class="State State--closed">${icon('closed')} Closed</span>`;
  if (pr.isDraft) return `<span class="State State--draft">${icon('draft')} Draft</span>`;
  return `<span class="State State--open">${icon('open')} Open</span>`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function checkRunPanel(id: string, url: string | null | undefined): string {
  const run = detail.runs.get(id);
  const link = url ? `<a class="d-link" href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ${icon('ext')}</a>` : '';
  if (!run || run === 'loading') return `<div class="d-check-panel">${spinnerHtml('Loading output…')}</div>`;
  if ('error' in run) return `<div class="d-check-panel"><div class="error-box">${esc(run.error)}</div>${link}</div>`;
  const anns = run.annotations?.nodes ?? [];
  const annHtml = anns.map((a) => {
    const lvl = (a.annotationLevel ?? 'NOTICE').toLowerCase();
    const ic = lvl === 'failure' ? icon('x', 'c-fail') : lvl === 'warning' ? icon('alert', 'c-pending') : icon('dot', 'c-muted');
    return `<div class="d-ann">
      <div class="d-ann-head">${ic}<code>${esc(a.path)}${a.location?.start?.line ? `:${a.location.start.line}` : ''}</code></div>
      ${a.title ? `<b>${esc(a.title)}</b>` : ''}
      <pre class="d-pre">${esc(clip(a.message, 1500))}</pre>
    </div>`;
  }).join('');
  const more = run.annotations && run.annotations.totalCount > anns.length
    ? `<p class="d-muted">+${run.annotations.totalCount - anns.length} more annotations</p>` : '';
  const summary = run.summary?.trim();
  const text = run.text?.trim();
  const empty = !run.title && !summary && !text && !anns.length;
  return `<div class="d-check-panel">
    ${run.title ? `<b>${esc(run.title)}</b>` : ''}
    ${summary ? `<pre class="d-pre">${esc(clip(summary, 4000))}</pre>` : ''}
    ${text ? `<details class="d-more"><summary>More output</summary><pre class="d-pre">${esc(clip(text, 6000))}</pre></details>` : ''}
    ${anns.length ? `<div class="d-subhead">Annotations</div>${annHtml}${more}` : ''}
    ${empty ? '<p class="d-muted">This check did not report any output. Full logs are only available on GitHub.</p>' : ''}
    ${link}
  </div>`;
}

function spinnerHtml(text: string): string {
  return `<div class="picker-status" style="border:0"><span class="spinner"></span>${esc(text)}</div>`;
}

function renderDetails(): void {
  const pr: PullRequest | null = detail.data ?? detail.pr;
  if (!pr) return;
  const d = detail.data;
  const me = state.viewer?.login;
  $('#detailTitle').textContent = `Pull request #${pr.number}`;
  $('#detailSub').textContent = `${ownerOf(pr)}/${repoOf(pr)}`;
  $<HTMLAnchorElement>('#detailGitHub').href = safeUrl(pr.url).replace(/&amp;/g, '&');

  const author = pr.author?.login ?? 'ghost';
  const opened = `opened ${timeAgo(pr.createdAt)}`;
  const parts: string[] = [];

  // Overview
  const labels = d?.labels?.nodes ?? [];
  parts.push(`
    <section class="d-hero">
      <div class="d-pills">${statePill(pr)}${reviewLabel(pr)}
        ${pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' ? `<span class="Label Label--attention">${icon('alert')} Conflicts</span>` : ''}
      </div>
      <h3 class="d-title">${esc(pr.title)}</h3>
      <p class="d-meta"><b>${esc(author)}</b> wants to merge <span class="branch">${esc(pr.headRefName)}</span> into <span class="branch">${esc(pr.baseRefName)}</span> · ${esc(opened)}</p>
      ${d ? `<p class="d-stats"><span class="add">+${d.additions}</span> <span class="del">−${d.deletions}</span>
        <span>· ${d.changedFiles} file${d.changedFiles === 1 ? '' : 's'}</span>
        <span>· ${d.commitsCount.totalCount} commit${d.commitsCount.totalCount === 1 ? '' : 's'}</span>
        <span>· ${d.recentComments.totalCount} comment${d.recentComments.totalCount === 1 ? '' : 's'}</span></p>` : ''}
      ${labels.length ? `<div class="d-labels">${labels.map((l) => `<span class="Label"><span class="lang-dot" style="background:#${esc(l.color)}"></span>${esc(l.name)}</span>`).join('')}</div>` : ''}
    </section>`);

  if (detail.error && !d) parts.push(`<div class="error-box">${esc(detail.error)}</div>`);
  if (!d) {
    if (!detail.error) parts.push(spinnerHtml('Loading details…'));
  } else {
    // Checks
    const checks = detailChecks(d);
    const jobs = hasCheckRuns(d) ? [] : sortJobs(detail.actions?.jobs ?? []);
    const total = (d.checks.nodes[0]?.commit.statusCheckRollup?.contexts.totalCount ?? 0) + jobs.length;
    const counts: Record<CheckBucket, number> = { pass: 0, fail: 0, pending: 0, skipped: 0 };
    for (const c of checks) counts[checkBucket(c)]++;
    for (const j of jobs) counts[actionsBucket(j.status, j.conclusion)]++;
    const countText = [
      counts.fail && `<span class="c-fail">${counts.fail} failed</span>`,
      counts.pending && `<span class="c-pending">${counts.pending} running</span>`,
      counts.pass && `<span class="c-pass">${counts.pass} passed</span>`,
      counts.skipped && `<span class="c-muted">${counts.skipped} skipped</span>`,
    ].filter(Boolean).join(' · ');
    // Status contexts and Actions jobs in one list, failures first.
    const order: Record<CheckBucket, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
    const checkRows = checks.map((c) => ({ bucket: checkBucket(c), html: (() => {
      const st = checkStatus(c);
      const isRun = c.__typename === 'CheckRun';
      const name = (isRun ? c.name : c.context) ?? 'check';
      const sub = isRun ? c.checkSuite?.workflowRun?.workflow.name : c.description;
      const open = detail.expanded.has(c.id);
      return `
        <div class="d-check${open ? ' open' : ''}">
          <button class="d-check-row" type="button" data-check="${esc(c.id)}" aria-expanded="${open}">
            ${BUCKET_ICON[st.bucket]}
            <span class="d-check-name"><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
            <span class="d-check-status c-${st.bucket}">${esc(st.text)}${st.time ? `<small>${esc(st.time)}</small>` : ''}</span>
            ${icon('chev', 'chev')}
          </button>
          ${open ? (isRun ? checkRunPanel(c.id, c.detailsUrl)
            : `<div class="d-check-panel">${c.description ? `<p>${esc(c.description)}</p>` : ''}${c.targetUrl ? `<a class="d-link" href="${safeUrl(c.targetUrl)}" target="_blank" rel="noopener noreferrer">Open details ${icon('ext')}</a>` : '<p class="d-muted">No further details.</p>'}</div>`) : ''}
        </div>`;
    })() }));
    const jobRows = jobs.map((j) => ({ bucket: actionsBucket(j.status, j.conclusion), html: jobRow(j) }));
    const rows = [...checkRows, ...jobRows].sort((a, b) => order[a.bucket] - order[b.bucket]).map((r) => r.html).join('');
    const actionsNote = detail.actions?.loading ? spinnerHtml('Loading GitHub Actions…')
      : detail.actions?.error ? `<p class="d-muted">${esc(detail.actions.error)}</p>` : '';
    parts.push(`
      <section class="d-section" id="detailChecks">
        <div class="d-head">
          <h4>Checks ${total ? `<span class="Counter">${total}</span>` : ''}</h4>
          <button class="btn btn-sm btn-invisible" type="button" data-dact="refresh" id="detailRefresh" title="Refresh">${icon('sync')}</button>
        </div>
        ${checks.length || jobs.length
          ? `<p class="d-counts">${countText}${hasPendingChecks(d) ? ' <span class="d-muted">· auto-refreshing</span>' : ''}</p><div class="d-list">${rows}</div>`
          : detail.actions?.loading ? '' : '<p class="d-muted">No checks reported for the latest commit.</p>'}
        ${actionsNote}
        ${total > checks.length + jobs.length ? `<p class="d-muted">+${total - checks.length - jobs.length} more checks not shown</p>` : ''}
      </section>`);

    // Reviews
    const reviews = d.latestReviews?.nodes ?? [];
    const reviewText: Record<string, [string, string]> = {
      APPROVED: [icon('check', 'c-pass'), 'approved'],
      CHANGES_REQUESTED: [icon('x', 'c-fail'), 'requested changes'],
      COMMENTED: [icon('comment', 'c-muted'), 'commented'],
      DISMISSED: [icon('skip', 'c-muted'), 'review dismissed'],
      PENDING: [icon('dot', 'c-pending'), 'review pending'],
    };
    const pending = (pr.reviewRequests?.nodes ?? [])
      .map((n) => n.requestedReviewer?.login ?? (n.requestedReviewer?.slug ? `@${n.requestedReviewer.slug}` : ''))
      .filter(Boolean);
    const reviewRows = [
      ...reviews.map((r) => {
        const [ic, text] = reviewText[r.state] ?? [icon('dot', 'c-muted'), r.state.toLowerCase()];
        const who = r.author?.login ?? 'ghost';
        return `<div class="d-row">${ic}<span><b>${esc(who === me ? 'You' : who)}</b> ${esc(text)}</span>${r.submittedAt ? `<span class="d-muted">${esc(timeAgo(r.submittedAt, true))}</span>` : ''}</div>`;
      }),
      ...pending.map((who) => `<div class="d-row">${icon('dot', 'c-pending')}<span><b>${esc(who === me ? 'You' : who)}</b> · review requested</span><span class="d-muted">waiting</span></div>`),
    ];
    parts.push(`
      <section class="d-section">
        <div class="d-head"><h4>Reviews</h4></div>
        ${reviewRows.length ? `<div class="d-list">${reviewRows.join('')}</div>` : '<p class="d-muted">No reviews yet.</p>'}
      </section>`);

    // Description
    const body = d.bodyText.trim();
    const long = body.length > 700;
    parts.push(`
      <section class="d-section">
        <div class="d-head"><h4>Description</h4></div>
        ${body ? `<div class="d-body">${esc(long && !detail.showFullBody ? clip(body, 700) : body)}</div>
          ${long ? `<button class="btn btn-sm" type="button" data-dact="body">${detail.showFullBody ? 'Show less' : 'Show more'}</button>` : ''}`
          : '<p class="d-muted">No description provided.</p>'}
      </section>`);

    // Commits
    const commits = d.recentCommits.nodes.map((n) => n.commit).reverse();
    parts.push(`
      <section class="d-section">
        <div class="d-head"><h4>Commits <span class="Counter">${d.commitsCount.totalCount}</span></h4></div>
        <div class="d-list">${commits.map((c) => `
          <div class="d-row d-commit"><code>${esc(c.abbreviatedOid)}</code>
            <span class="d-grow">${esc(c.messageHeadline)}<small>${esc(c.author?.user?.login ?? c.author?.name ?? '')} · ${esc(timeAgo(c.committedDate, true))}</small></span>
          </div>`).join('')}</div>
        ${d.commitsCount.totalCount > commits.length ? `<p class="d-muted">Showing the latest ${commits.length} of ${d.commitsCount.totalCount}</p>` : ''}
      </section>`);

    // Comments
    const comments = d.recentComments.nodes;
    parts.push(`
      <section class="d-section">
        <div class="d-head"><h4>Comments <span class="Counter">${d.recentComments.totalCount}</span></h4></div>
        ${comments.length ? `<div class="d-comments">${comments.map((c) => `
          <div class="d-comment">
            <div class="d-comment-head"><b>${esc(c.author?.login ?? 'ghost')}</b><span class="d-muted">${esc(timeAgo(c.createdAt, true))}</span></div>
            <div class="d-body">${esc(clip(c.bodyText.trim(), 1200))}</div>
          </div>`).join('')}</div>
          ${d.recentComments.totalCount > comments.length ? `<p class="d-muted">Showing the latest ${comments.length} of ${d.recentComments.totalCount}</p>` : ''}`
          : '<p class="d-muted">No comments.</p>'}
      </section>`);
  }
  $('#detailBody').innerHTML = parts.join('');

  // Footer actions follow the same rules as the card.
  const fresh = d ?? pr;
  $('#detailFooter').innerHTML = [
    `<button class="btn" data-dact="files">${icon('diff')}Files</button>`,
    canReview(fresh) ? `<button class="btn" data-dact="review">${icon('comment')}Review</button>` : '',
    canMerge(fresh) ? `<button class="btn btn-primary" data-dact="merge">${icon('merged')}Merge</button>` : '',
  ].join('');
}

function sortJobs(jobs: Job[]): Job[] {
  const order: Record<CheckBucket, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
  return [...jobs].sort((a, b) => order[actionsBucket(a.status, a.conclusion)] - order[actionsBucket(b.status, b.conclusion)] || a.name.localeCompare(b.name));
}

function span(start: string | null, end: string | null): string {
  if (!start) return '';
  const t = formatDuration((end ? Date.parse(end) : Date.now()) - Date.parse(start));
  return end ? t : `for ${t}`;
}

/** A GitHub Actions job row; expands to its steps (the failed step is marked). */
function jobRow(j: Job): string {
  const key = `job-${j.id}`;
  const bucket = actionsBucket(j.status, j.conclusion);
  const open = detail.expanded.has(key);
  const steps = (j.steps ?? []).map((st) => {
    const b = actionsBucket(st.status, st.conclusion);
    return `<div class="d-step${b === 'fail' ? ' failed' : ''}">${BUCKET_ICON[b]}<span>${esc(st.name)}</span><small>${esc(span(st.started_at, st.completed_at))}</small></div>`;
  }).join('');
  return `
    <div class="d-check${open ? ' open' : ''}">
      <button class="d-check-row" type="button" data-check="${key}" aria-expanded="${open}">
        ${BUCKET_ICON[bucket]}
        <span class="d-check-name"><b>${esc(j.name)}</b>${j.workflow_name ? `<small>${esc(j.workflow_name)}</small>` : ''}</span>
        <span class="d-check-status c-${bucket}">${esc(actionsText(j.status, j.conclusion))}<small>${esc(span(j.started_at, j.completed_at))}</small></span>
        ${icon('chev', 'chev')}
      </button>
      ${open ? `<div class="d-check-panel">
        ${steps ? `<div class="d-steps">${steps}</div>` : '<p class="d-muted">No steps reported yet.</p>'}
        <p class="d-muted">Full logs are only available on GitHub.</p>
        ${j.html_url ? `<a class="d-link" href="${safeUrl(j.html_url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ${icon('ext')}</a>` : ''}
      </div>` : ''}
    </div>`;
}

async function toggleCheck(id: string): Promise<void> {
  if (detail.expanded.has(id)) {
    detail.expanded.delete(id);
    return renderDetails();
  }
  detail.expanded.add(id);
  const check = detail.data ? detailChecks(detail.data).find((c) => c.id === id) : undefined;
  if (check?.__typename !== 'CheckRun' || detail.runs.has(id)) return renderDetails();
  detail.runs.set(id, 'loading');
  renderDetails();
  try {
    const run = await fetchCheckRunDetail(id);
    detail.runs.set(id, run ?? { error: 'Check not found.' });
  } catch (e) {
    detail.runs.set(id, { error: (e as Error).message });
  }
  renderDetails();
}

// ---------- Review ----------

function openReview(pr: PullRequest): void {
  state.current = pr;
  $('#reviewSub').textContent = `${repoOf(pr)}#${pr.number} · ${pr.title}`;
  $<HTMLTextAreaElement>('#reviewBody').value = '';
  // Approving twice is pointless; offer comment / request changes instead.
  const approved = pr.viewerLatestReview?.state === 'APPROVED';
  const approve = $<HTMLInputElement>('input[name=event][value=APPROVE]');
  approve.disabled = approved;
  $<HTMLInputElement>(`input[name=event][value=${approved ? 'COMMENT' : 'APPROVE'}]`).checked = true;
  if (approved) $('#reviewSub').textContent += ' · You already approved this';
  openDialog('#reviewSheet');
}

async function submitReview(): Promise<void> {
  const pr = state.current;
  if (!pr) return;
  const event = $<HTMLInputElement>('input[name=event]:checked').value as ReviewEvent;
  const body = $<HTMLTextAreaElement>('#reviewBody').value.trim();
  if (event !== 'APPROVE' && !body) return toast('Please add a comment for this review type.', 'err');
  if (isMine(pr) && event !== 'COMMENT') return toast('You can’t approve or request changes on your own pull request.', 'err');
  try {
    await withBusy($<HTMLButtonElement>('#reviewConfirm'), () => rest.review(ownerOf(pr), repoOf(pr), pr.number, event, body));
    closeDialog();
    const verb = { APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes on', COMMENT: 'Commented on' }[event];
    toast(`${verb} ${repoOf(pr)}#${pr.number}`, 'ok');
    void refreshOne(pr);
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

// ---------- Merge ----------

let mergeHeadSha = '';

function mergeStatus(cls: 'ok' | 'bad' | 'warn' | 'wait', ic: 'check' | 'x' | 'alert' | 'dot', title: string, sub: string): void {
  $('#mergeStatus').innerHTML =
    `<span class="ic ${cls}">${cls === 'wait' ? '<span class="spinner"></span>' : icon(ic)}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span>`;
}

async function openMerge(pr: PullRequest): Promise<void> {
  state.current = pr;
  mergeHeadSha = '';
  $('#mergeSub').textContent = `${repoOf(pr)}#${pr.number} · ${pr.headRefName} → ${pr.baseRefName}`;
  const confirm = $<HTMLButtonElement>('#mergeConfirm');
  confirm.disabled = true;
  mergeStatus('wait', 'dot', 'Checking mergeability…', 'Asking GitHub about conflicts and branch protection.');
  openDialog('#mergeSheet');

  try {
    const [pull, settings] = await Promise.all([
      pollMergeable(ownerOf(pr), repoOf(pr), pr.number),
      fetchMergeSettings(ownerOf(pr), repoOf(pr)).catch(() => null),
    ]);
    if (state.current !== pr) return;
    mergeHeadSha = pull.head.sha;

    // Allowed merge methods for this repository.
    const allowed: Record<MergeMethod, boolean> = {
      squash: settings?.squashMergeAllowed ?? true,
      merge: settings?.mergeCommitAllowed ?? true,
      rebase: settings?.rebaseMergeAllowed ?? true,
    };
    const preferred = (settings?.viewerDefaultMergeMethod?.toLowerCase() ?? 'squash') as MergeMethod;
    const radios = document.querySelectorAll<HTMLInputElement>('input[name=method]');
    radios.forEach((r) => { r.disabled = !allowed[r.value as MergeMethod]; r.checked = false; });
    const pick = allowed[preferred] ? preferred : (Object.keys(allowed) as MergeMethod[]).find((m) => allowed[m]);
    if (pick) $<HTMLInputElement>(`input[name=method][value=${pick}]`).checked = true;

    let canTry = !!pick;
    switch (pull.mergeable_state) {
      case 'clean':
      case 'has_hooks':
        mergeStatus('ok', 'check', 'This branch has no conflicts with the base branch', 'Merging can be performed automatically.');
        break;
      case 'dirty':
        canTry = false;
        mergeStatus('bad', 'x', 'This branch has conflicts that must be resolved', 'Resolve the conflicts on GitHub, then come back.');
        break;
      case 'draft':
        canTry = false;
        mergeStatus('bad', 'x', 'This pull request is still a draft', 'Mark it ready for review on GitHub first.');
        break;
      case 'blocked':
        mergeStatus('warn', 'alert', 'Merging is blocked', 'Required reviews or checks are missing. GitHub will refuse unless you can bypass branch protection.');
        break;
      case 'behind':
        mergeStatus('warn', 'alert', 'This branch is out-of-date with the base branch', 'Branch protection may require updating it first.');
        break;
      case 'unstable':
        mergeStatus('warn', 'alert', 'Some checks were not successful or are still running', 'You can still try to merge.');
        break;
      default:
        mergeStatus('warn', 'dot', 'GitHub is still computing mergeability', 'You can try to merge; GitHub will refuse if it is not possible.');
    }
    if (pull.merged) { canTry = false; mergeStatus('ok', 'check', 'Already merged', ''); }
    confirm.disabled = !canTry;
  } catch (e) {
    mergeStatus('bad', 'x', 'Could not check this pull request', (e as Error).message);
  }
}

/** GitHub computes `mergeable` lazily; poll briefly while it is null. */
async function pollMergeable(owner: string, repo: string, n: number): Promise<RestPull> {
  let pull = await rest.pull(owner, repo, n);
  for (let i = 0; i < 3 && pull.mergeable === null && pull.state === 'open'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    pull = await rest.pull(owner, repo, n);
  }
  return pull;
}

async function confirmMerge(): Promise<void> {
  const pr = state.current;
  if (!pr || !mergeHeadSha) return;
  const method = $<HTMLInputElement>('input[name=method]:checked').value as MergeMethod;
  try {
    await withBusy($<HTMLButtonElement>('#mergeConfirm'), () => rest.merge(ownerOf(pr), repoOf(pr), pr.number, method, mergeHeadSha));
    closeDialog();
    toast(`Merged ${repoOf(pr)}#${pr.number} (${method})`, 'ok');
    void refreshOne(pr);
  } catch (e) {
    toast((e as Error).message, 'err');
  }
}

// ---------- Files changed ----------

let filesPage = 1;
let filesAll: RestFile[] = [];

async function openFiles(pr: PullRequest): Promise<void> {
  state.current = pr;
  filesPage = 1;
  filesAll = [];
  $('#filesSub').textContent = `${repoOf(pr)}#${pr.number} · ${pr.headRefName} → ${pr.baseRefName}`;
  $('#filesSummary').innerHTML = '';
  $('#filesList').innerHTML = '<div class="loading-row"><span class="spinner"></span></div>';
  $('#filesMoreWrap').classList.add('hidden');
  openDialog('#filesSheet');
  await loadFilesPage(pr);
}

async function loadFilesPage(pr: PullRequest): Promise<void> {
  try {
    const page = await rest.files(ownerOf(pr), repoOf(pr), pr.number, filesPage);
    if (state.current !== pr) return;
    filesAll.push(...page);
    renderFiles();
    $('#filesMoreWrap').classList.toggle('hidden', page.length < 100 || filesPage >= 30);
  } catch (e) {
    $('#filesList').innerHTML = `<div class="error-box">${esc((e as Error).message)}</div>`;
  }
}

function renderFiles(): void {
  const adds = filesAll.reduce((s, f) => s + f.additions, 0);
  const dels = filesAll.reduce((s, f) => s + f.deletions, 0);
  const statusLabel: Record<string, string> = { added: 'Label--success', removed: 'Label--danger', modified: 'Label--attention', renamed: 'Label--done' };
  $('#filesSummary').innerHTML =
    `<span><b>${filesAll.length} changed file${filesAll.length === 1 ? '' : 's'}</b> with <span class="add">${adds} additions</span> and <span class="del">${dels} deletions</span></span>${diffstat(adds, dels)}`;
  $('#filesList').innerHTML = filesAll.length ? filesAll.map((f, i) => {
    const name = f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename;
    return `
      <details class="file" ${i < 3 && f.changes < 400 ? 'open' : ''}>
        <summary>
          ${icon('chev', 'chev')}
          <span class="fname" title="${esc(name)}">&lrm;${esc(name)}</span>
          <span class="Label ${statusLabel[f.status] ?? ''}">${esc(f.status)}</span>
          <span class="fstat mono"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span>${diffstat(f.additions, f.deletions)}</span>
        </summary>
        ${f.patch
          ? `<div class="diff-wrap"><table class="diff">${renderPatch(f.patch)}</table></div>`
          : `<div class="diff-note">Binary file or diff too large to show. <a href="${safeUrl(f.blob_url)}" target="_blank" rel="noopener noreferrer">View on GitHub</a></div>`}
      </details>`;
  }).join('') : '<div class="blankslate">No file changes.</div>';
}

// ---------- Org / repo picker (Favourites | All) ----------

type PickerKind = 'owner' | 'repo';

interface PickItem {
  value: string;
  label: string;
  avatar?: string;
  /** Plain text, searchable and highlighted. */
  sub?: string;
  /** Extra HTML (already escaped), not searchable. */
  extra?: string;
  count?: number;
  /** null = cannot be starred (e.g. "open by name"). */
  fav: boolean | null;
}

const picker = {
  kind: 'owner' as PickerKind,
  tab: 'fav' as 'fav' | 'all',
  loading: false,
  error: '',
  /** Server-side repo search while typing in the repo picker. */
  remote: { q: '', loading: false, results: null as Repo[] | null, error: '' },
};
const repoSearchCache = new Map<string, Repo[]>();
/** Repos seen per owner (recent list + search hits), so favourites can show details. */
const knownRepos = new Map<string, Map<string, Repo>>();
let repoSearchTimer = 0;

function remember(owner: string, repos: Repo[]): void {
  const key = owner.toLowerCase();
  const m = knownRepos.get(key) ?? new Map<string, Repo>();
  for (const r of repos) m.set(r.name.toLowerCase(), r);
  knownRepos.set(key, m);
}

function highlight(text: string, q: string): string {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

function ownerItems(): PickItem[] {
  const me = state.viewer;
  const seen = new Set<string>();
  const items: PickItem[] = [];
  const add = (login: string, avatar: string | undefined, sub: string) => {
    if (seen.has(login.toLowerCase())) return;
    seen.add(login.toLowerCase());
    items.push({ value: login, label: login, avatar, sub, fav: favorites.isOrg(login) });
  };
  const avatars = new Map((me?.organizations.nodes ?? []).map((o) => [o.login.toLowerCase(), o.avatarUrl]));
  if (me) avatars.set(me.login.toLowerCase(), me.avatarUrl);
  const subFor = (login: string) =>
    login.toLowerCase() === me?.login.toLowerCase() ? 'Your personal account'
      : avatars.has(login.toLowerCase()) ? 'Organization' : 'Added by name';
  // Favourites first, then the rest.
  for (const o of favorites.orgs()) add(o, avatars.get(o.toLowerCase()), subFor(o));
  for (const o of me?.organizations.nodes ?? []) add(o.login, o.avatarUrl, 'Organization');
  if (me) add(me.login, me.avatarUrl, 'Your personal account');
  return items;
}

function repoItem(r: Repo): PickItem {
  return {
    value: r.name,
    label: r.name,
    sub: r.description ?? undefined,
    count: r.pullRequests.totalCount >= 0 ? r.pullRequests.totalCount : undefined,
    fav: favorites.isRepo(state.owner, r.name),
    extra:
      (r.primaryLanguage ? `<span><span class="lang-dot" style="background:${esc(r.primaryLanguage.color ?? '#8b949e')}"></span>${esc(r.primaryLanguage.name)}</span>` : '') +
      `<span class="Label" style="height:18px;line-height:16px">${r.isPrivate ? 'Private' : 'Public'}</span>` +
      (r.pushedAt ? `<span>Updated ${esc(timeAgo(r.pushedAt))}</span>` : ''),
  };
}

/** Recently updated repos (cached), favourites first. */
function recentRepoItems(): PickItem[] {
  const repos = [...(cache.repos(state.owner)?.data ?? [])];
  const favOrder = favorites.repos(state.owner).map((n) => n.toLowerCase());
  const rank = (name: string) => {
    const i = favOrder.indexOf(name.toLowerCase());
    return i < 0 ? Infinity : i;
  };
  repos.sort((a, b) => rank(a.name) - rank(b.name));
  return repos.map(repoItem);
}

function favItemsFor(isOwner: boolean, all: PickItem[]): PickItem[] {
  if (isOwner) {
    const byValue = new Map(all.map((i) => [i.value.toLowerCase(), i]));
    return favorites.orgs().map((v) => byValue.get(v.toLowerCase()) ?? { value: v, label: v, fav: true });
  }
  const known = knownRepos.get(state.owner.toLowerCase());
  return favorites.repos(state.owner).map((v) => {
    const r = known?.get(v.toLowerCase());
    return r ? repoItem(r) : { value: v, label: v, fav: true };
  });
}

function pickItemHtml(it: PickItem, q: string, selected: boolean): string {
  const v = esc(it.value);
  const star = it.fav === null ? '' : `
    <button class="star" type="button" data-star="${v}" aria-pressed="${it.fav}"
      aria-label="${it.fav ? 'Remove from' : 'Add to'} favourites" title="${it.fav ? 'Remove from' : 'Add to'} favourites">${icon(it.fav ? 'starFill' : 'star')}</button>`;
  return `
    <div class="picker-item" role="option" aria-selected="${selected}">
      <button class="pick" type="button" data-pick="${v}">
        ${icon('check', 'tick')}
        <b>${it.avatar ? `<img class="avatar sm" src="${safeUrl(it.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}<span>${highlight(it.label, q)}</span></b>
        ${it.count !== undefined ? `<span class="Counter" title="Open pull requests">${it.count}</span>` : '<span></span>'}
        ${it.sub || it.extra ? `<small>${it.sub ? `<span>${highlight(it.sub, q)}</span>` : ''}${it.extra ?? ''}</small>` : ''}
      </button>${star}
    </div>`;
}

const section = (title: string) => `<div class="picker-section">${esc(title)}</div>`;
const spinnerRow = (text: string) => `<div class="picker-status"><span class="spinner"></span>${esc(text)}</div>`;

function renderPicker(): void {
  const isOwner = picker.kind === 'owner';
  const qRaw = $<HTMLInputElement>('#pickerQ').value.trim();
  const q = qRaw.toLowerCase();
  const all = isOwner ? ownerItems() : recentRepoItems();
  const favItems = favItemsFor(isOwner, all);
  const current = (isOwner ? state.owner : state.repo).toLowerCase();
  const row = (i: PickItem) => pickItemHtml(i, q, i.value.toLowerCase() === current);
  const matches = (i: PickItem) => i.label.toLowerCase().includes(q) || (i.sub ?? '').toLowerCase().includes(q);

  $('#pickerFavCount').textContent = String(favItems.length);
  const allCount = $('#pickerAllCount');
  allCount.textContent = isOwner ? String(all.length) : '';
  allCount.classList.toggle('hidden', !isOwner);
  const syncedAt = isOwner ? cache.viewer()?.at : cache.repos(state.owner)?.at;
  $('#pickerDesc').textContent = (isOwner ? 'Organizations' : `Repositories in ${state.owner}`) +
    (picker.loading ? ' · syncing…' : syncedAt ? ` · synced ${timeAgo(new Date(syncedAt).toISOString())}` : '');
  // While searching, results span favourites and everything else, so the tabs step aside.
  $('#pickerTabs').classList.toggle('hidden', !!q);
  document.querySelectorAll<HTMLElement>('[data-ptab]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.ptab === picker.tab)));

  let html = '';
  if (q) {
    const seen = new Set<string>();
    const take = (items: PickItem[]) => items.filter((i) => {
      const k = i.value.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const local = take([...favItems, ...all].filter(matches));
    html = local.map(row).join('');
    if (isOwner) {
      // Jump to any org/user by name.
      if (!seen.has(q) && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(qRaw)) {
        html += pickItemHtml({ value: qRaw, label: qRaw, sub: 'Open this organization or user (adds it to favourites)', fav: null }, '', false);
      }
      if (!html) html = '<div class="picker-empty">No matches.</div>';
    } else {
      const r = picker.remote;
      const remote = r.q === q && r.results ? take(r.results.map(repoItem)) : [];
      if (remote.length) html += (local.length ? section(`More in ${state.owner}`) : '') + remote.map(row).join('');
      if (r.loading) html += spinnerRow(`Searching ${state.owner}…`);
      else if (r.error) html += `<div class="error-box" style="margin:12px 16px">${esc(r.error)}</div>`;
      else if (!html) html = `<div class="picker-empty">No repositories in ${esc(state.owner)} match “${esc(qRaw)}”.</div>`;
    }
  } else if (picker.tab === 'fav') {
    html = favItems.map(row).join('') || `<div class="picker-empty">${icon('starFill')}
      <p><b>No favourite ${isOwner ? 'organizations' : 'repositories'} yet</b></p>
      <p>Open <b>All</b> and tap ☆ to pin the ones you use.</p></div>`;
  } else if (isOwner) {
    html = all.map(row).join('');
  } else {
    if (all.length) {
      html = section('Recently updated') + all.map(row).join('') +
        `<div class="picker-status">${icon('search')}Type above to search every repository in ${esc(state.owner)}</div>`;
    } else if (picker.loading) html = spinnerRow('Loading recent repositories…');
    else if (picker.error) html = `<div class="error-box" style="margin:16px">${esc(picker.error)}</div>`;
    else html = '<div class="picker-empty">No repositories found.</div>';
  }
  $('#pickerList').innerHTML = html;
}

/** Debounced server-side search for the repo picker. */
function scheduleRepoSearch(): void {
  clearTimeout(repoSearchTimer);
  const text = $<HTMLInputElement>('#pickerQ').value.trim();
  const q = text.toLowerCase();
  const owner = state.owner;
  if (picker.kind !== 'repo' || !q) {
    picker.remote = { q: '', loading: false, results: null, error: '' };
    return;
  }
  const key = `${owner.toLowerCase()}|${q}`;
  const hit = repoSearchCache.get(key);
  if (hit) {
    picker.remote = { q, loading: false, results: hit, error: '' };
    return;
  }
  picker.remote = { q, loading: true, results: null, error: '' };
  repoSearchTimer = window.setTimeout(async () => {
    let results: Repo[] | null = null;
    let error = '';
    try {
      results = await searchRepos(owner, text);
      repoSearchCache.set(key, results);
      remember(owner, results);
    } catch (e) {
      error = (e as Error).message;
    }
    if (picker.remote.q !== q || state.owner !== owner) return; // stale
    picker.remote = { q, loading: false, results, error };
    renderPicker();
  }, 300);
}

async function openPicker(kind: PickerKind): Promise<void> {
  picker.kind = kind;
  picker.error = '';
  picker.loading = false;
  picker.remote = { q: '', loading: false, results: null, error: '' };
  const isOwner = kind === 'owner';
  const favCount = isOwner ? favorites.orgs().length : favorites.repos(state.owner).length;
  picker.tab = favCount ? 'fav' : 'all';
  $('#pickerTitle').textContent = isOwner ? 'Select organization' : 'Select repository';
  const input = $<HTMLInputElement>('#pickerQ');
  input.value = '';
  input.placeholder = isOwner ? 'Filter or type an org name' : `Search repositories in ${state.owner}`;
  if (!isOwner) remember(state.owner, cache.repos(state.owner)?.data ?? []);
  renderPicker();
  openDialog('#pickerSheet');
  // Don't pop the on-screen keyboard on phones.
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => input.focus(), 50);
  // Recent repos load once per org, then come from the local cache until "Sync".
  if (!isOwner && !cache.repos(state.owner)) await syncPicker();
}

/** Re-fetches the picker's list from GitHub and updates the local cache. */
async function syncPicker(): Promise<void> {
  const kind = picker.kind;
  const owner = state.owner;
  picker.loading = true;
  picker.error = '';
  renderPicker();
  const btn = $<HTMLButtonElement>('#pickerSync');
  btn.disabled = true;
  try {
    if (kind === 'owner') {
      const viewer = await fetchViewer(true);
      cache.setViewer(viewer);
      state.viewer = viewer;
      $<HTMLImageElement>('#meAvatar').src = viewer.avatarUrl;
    } else {
      await tokenRepos(true);
      const recent = await fetchRecentRepos(owner);
      cache.setRepos(owner, recent);
      remember(owner, recent);
      for (const k of [...repoSearchCache.keys()]) if (k.startsWith(`${owner.toLowerCase()}|`)) repoSearchCache.delete(k);
    }
  } catch (e) {
    picker.error = (e as Error).message;
    toast(picker.error, 'err');
  } finally {
    btn.disabled = false;
  }
  if (picker.kind !== kind || state.owner !== owner) return;
  picker.loading = false;
  scheduleRepoSearch();
  renderPicker();
}

function onPick(value: string): void {
  closeDialog();
  if (picker.kind === 'owner') {
    if (value.toLowerCase() === state.owner.toLowerCase()) return;
    if (!ownerItems().some((i) => i.value.toLowerCase() === value.toLowerCase())) {
      favorites.addOrg(value);
      toast(`Added ${value} to favourites`);
    }
    void selectOwner(value);
  } else {
    state.repo = value;
    saveLast();
    void loadPrs(true);
  }
}

function onStar(value: string): void {
  const on = picker.kind === 'owner' ? favorites.toggleOrg(value) : favorites.toggleRepo(state.owner, value);
  toast(`${on ? 'Added' : 'Removed'} ${value} ${on ? 'to' : 'from'} favourites`);
  renderPicker();
}

// ---------- Theme ----------

type Theme = 'auto' | 'light' | 'dark';
function applyTheme(t: Theme): void {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = $('#themeBtn');
  btn.textContent = { auto: '◐', light: '☀', dark: '☾' }[t];
  btn.title = `Theme: ${t}`;
  storage.set(THEME_KEY, t);
}

// ---------- Installable app (PWA) ----------

/** The browser shows its own install prompt/menu item; we only register the service worker. */
function registerServiceWorker(): void {
  // Service workers only run on built, secure (HTTPS or localhost) pages.
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker not registered', e));
    });
  }
}

// ---------- Token access check ----------

interface DiagRow {
  label: string;
  ok: boolean | null; // null = skipped
  detail: string;
}

let diagReport = '';

function renderDiag(rows: DiagRow[], hints: string[], running: boolean): void {
  const mark = (r: DiagRow) => (r.ok === null ? icon('skip', 'c-muted') : r.ok ? icon('check', 'c-pass') : icon('x', 'c-fail'));
  $('#diagBody').innerHTML =
    `<div class="d-list">${rows.map((r) => `
      <div class="d-row">${mark(r)}<span class="d-grow"><b>${esc(r.label)}</b><small class="diag-detail">${esc(r.detail)}</small></span></div>`).join('')}
      ${running ? spinnerHtml('Checking…') : ''}</div>` +
    (hints.length ? `<div class="diag-hints"><b>What to fix</b><ul>${hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>` : '');
  diagReport = [
    'PR Dashboard token check',
    ...rows.map((r) => `${r.ok === null ? '-' : r.ok ? 'OK ' : 'ERR'} ${r.label}: ${r.detail}`),
    ...(hints.length ? ['', 'Hints:', ...hints.map((h) => `- ${h}`)] : []),
  ].join('\n');
}

async function runDiagnostics(): Promise<void> {
  openDialog('#diagSheet');
  const rows: DiagRow[] = [];
  const hints: string[] = [];
  const add = (row: DiagRow) => { rows.push(row); renderDiag(rows, hints, true); };
  renderDiag(rows, hints, true);
  const fine = isFineGrained();
  const gql = (query: string, variables: Record<string, unknown> = {}) =>
    probe('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });

  // 1. Who is this token?
  const user = await probe('/user');
  const login = (user.body as { login?: string } | null)?.login ?? '?';
  add({ label: 'Token signs in', ok: user.ok, detail: user.ok
    ? `as ${login} · ${fine ? 'fine-grained token' : `classic token · scopes: ${user.scopes || 'none'}`}` : user.message });
  if (!user.ok) {
    hints.push('The token is invalid, expired or revoked. Create a new one and sign in again.');
    return renderDiag(rows, hints, false);
  }

  // 2. Organizations (GraphQL), as the org picker uses.
  const orgs = await gql('query { viewer { organizations(first: 100) { nodes { login } } } }');
  const orgNodes = (orgs.body as { data?: { viewer?: { organizations?: { nodes: Array<{ login: string }> } } } } | null)?.data?.viewer?.organizations?.nodes ?? [];
  add({ label: 'Can list your organizations', ok: orgs.ok && orgNodes.length > 0,
    detail: orgs.ok ? (orgNodes.length ? orgNodes.map((o) => o.login).join(', ') : 'none returned') : orgs.message });

  // 3. Repositories the token can reach.
  const repos = await probe('/user/repos?per_page=100&sort=pushed');
  const repoList = Array.isArray(repos.body) ? (repos.body as Array<{ full_name: string }>).map((r) => r.full_name) : [];
  add({ label: 'Repositories this token can reach', ok: repos.ok && repoList.length > 0,
    detail: repos.ok ? (repoList.length ? `${repoList.length}: ${repoList.slice(0, 8).join(', ')}${repoList.length > 8 ? '…' : ''}` : 'none') : repos.message });
  if (fine && !orgNodes.length && repoList.length) {
    hints.push('Fine-grained tokens can’t list organizations; the app now finds them from the repositories above. You can also type the org name in the org picker.');
  }
  if (!repoList.length) {
    hints.push(fine
      ? 'The token reaches no repositories. If the organization requires approval for fine-grained tokens, an org owner must approve it (Organization → Settings → Personal access tokens → Pending requests). Also check “Repository access” on the token.'
      : 'The token reaches no repositories. A classic token needs the “repo” scope (and SSO authorization for SSO organizations).');
  }

  // 4–8. The selected repository.
  const owner = state.owner;
  const repo = state.repo;
  if (!owner || !repo) {
    add({ label: 'Selected repository', ok: null, detail: 'none selected yet' });
    return renderDiag(rows, hints, false);
  }
  const full = `${owner}/${repo}`;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const r = await probe(path);
  add({ label: `Can open ${full}`, ok: r.ok, detail: r.ok ? 'OK' : r.message });
  if (r.sso) hints.push(`SSO: authorize the token for this organization: ${r.sso}`);
  if (!r.ok) {
    hints.push(`${full} is not in the token’s repository access (or the token is waiting for org approval). Pick a repository listed above, or edit the token.`);
    return renderDiag(rows, hints, false);
  }

  const pulls = await probe(`${path}/pulls?state=all&per_page=1`);
  const firstPr = Array.isArray(pulls.body) ? (pulls.body as Array<{ number: number; head: { sha: string } }>)[0] : undefined;
  add({ label: 'Can read pull requests', ok: pulls.ok, detail: pulls.ok ? (firstPr ? `latest #${firstPr.number}` : 'repository has no pull requests') : pulls.message });
  if (!pulls.ok) hints.push('Give the token “Pull requests: Read and write”.');

  const search = await gql('query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }', { q: `repo:${full} is:pr` });
  const count = (search.body as { data?: { search?: { issueCount: number } } } | null)?.data?.search?.issueCount;
  add({ label: 'Pull request search (used for the list)', ok: search.ok, detail: search.ok ? `${count} pull requests found` : search.message });

  if (firstPr) {
    const status = await probe(`${path}/commits/${firstPr.head.sha}/status`);
    add({ label: 'Can read commit statuses', ok: status.ok, detail: status.ok ? 'OK' : status.message });
    if (!status.ok) hints.push('To show commit statuses, give the token “Commit statuses: Read”.');
    if (fine) {
      // Fine-grained tokens have no "Checks" permission; the app reads GitHub Actions via the Actions API.
      const actions = await probe(`${path}/actions/runs?per_page=1`);
      add({ label: 'Can read GitHub Actions runs', ok: actions.ok, detail: actions.ok ? 'OK' : actions.message });
      if (!actions.ok) hints.push('To show GitHub Actions results, give the token “Actions: Read” (fine-grained tokens can’t read check runs).');
    } else {
      const runs = await probe(`${path}/commits/${firstPr.head.sha}/check-runs?per_page=1`);
      add({ label: 'Can read check runs', ok: runs.ok, detail: runs.ok ? 'OK' : runs.message });
      if (!runs.ok) hints.push('To show check runs, the classic token needs the “repo” scope.');
    }
  } else {
    add({ label: 'Checks / statuses', ok: null, detail: 'skipped (no pull request to test with)' });
  }

  if (fine) hints.push('To merge from the app, the token also needs “Contents: Read and write”. Apps can’t read a fine-grained token’s permissions, so this one isn’t tested.');
  renderDiag(rows, hints, false);
}

// ---------- Wiring ----------

function findPr(id: string | undefined): PullRequest | undefined {
  return state.prs.find((p) => p.id === id);
}

function init(): void {
  hydrateIcons();
  initDialogs();
  setWarningHandler((msg) => toast(msg, 'err'));

  let theme = (storage.get(THEME_KEY) as Theme | null) ?? 'auto';
  applyTheme(theme);
  $('#themeBtn').addEventListener('click', () => {
    const order: Theme[] = ['auto', 'light', 'dark'];
    theme = order[(order.indexOf(theme) + 1) % order.length];
    applyTheme(theme);
  });

  // Token type tabs on the sign-in page.
  document.querySelectorAll<HTMLElement>('[data-ttab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('[data-ttab]').forEach((t) => t.setAttribute('aria-pressed', String(t === tab)));
      document.querySelectorAll<HTMLElement>('[data-tpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.tpanel !== tab.dataset.ttab));
    }));

  // Sign in: the token is saved only if it meets the minimum requirements.
  let pendingToken: string | null = null;
  const accept = (token: string) => {
    saveToken(token);
    pendingToken = null;
    $<HTMLInputElement>('#token').value = '';
    $('#tokenCheck').classList.add('hidden');
    $('#loginContinue').classList.add('hidden');
    void boot();
  };
  $('#token').addEventListener('input', () => {
    pendingToken = null;
    $('#loginContinue').classList.add('hidden');
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $<HTMLInputElement>('#token').value.trim();
    if (!token) return;
    pendingToken = null;
    $('#loginContinue').classList.add('hidden');
    setLoginMessage('');
    const result = await withBusy($<HTMLButtonElement>('#loginBtn'), () => checkToken(token, renderTokenCheck));
    renderTokenCheck(result.items);
    if (!result.ok) {
      setLoginMessage('This token doesn’t meet the minimum requirements, so it wasn’t saved. Fix the items marked ✕ and try again.');
      return;
    }
    if (result.items.some((i) => i.status === 'warn')) {
      pendingToken = token;
      $('#loginContinue').classList.remove('hidden');
      setLoginMessage('The token works, but some features will be limited (see ⚠ above).', 'warn');
      return;
    }
    accept(token);
  });
  $('#loginContinue').addEventListener('click', () => { if (pendingToken) accept(pendingToken); });

  $('#logoutBtn').addEventListener('click', () => {
    if (!confirm('Remove the token from this browser?')) return;
    forgetToken();
    storage.remove(LAST_KEY);
    cache.clear();
    state.prs = [];
    toast('Token removed from this browser');
    showLogin();
  });

  $('#refreshBtn').addEventListener('click', () => void loadPrs(true));
  $('#pickerSync').addEventListener('click', () => void syncPicker());

  $('#ownerBtn').addEventListener('click', () => void openPicker('owner'));
  $('#repoBtn').addEventListener('click', () => void openPicker('repo'));
  $('#pickerQ').addEventListener('input', () => {
    scheduleRepoSearch();
    renderPicker();
  });
  $('#pickerQ').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') document.querySelector<HTMLButtonElement>('#pickerList .pick')?.click();
  });
  document.querySelectorAll<HTMLElement>('[data-ptab]').forEach((b) =>
    b.addEventListener('click', () => {
      picker.tab = b.dataset.ptab as 'fav' | 'all';
      renderPicker();
    }));
  $('#pickerList').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const star = target.closest<HTMLElement>('[data-star]');
    if (star) return onStar(star.dataset.star ?? '');
    const pick = target.closest<HTMLElement>('[data-pick]');
    if (pick) onPick(pick.dataset.pick ?? '');
  });

  let debounce = 0;
  const q = $<HTMLInputElement>('#q');
  const runSearch = (save: boolean) => {
    clearTimeout(debounce);
    const text = q.value.trim();
    if (save) rememberSearch(text);
    if (text === state.query) return;
    state.query = text;
    void loadPrs(true);
  };
  // Search as you type, but not while a qualifier like "label:" is still missing its value.
  q.addEventListener('input', () => {
    clearTimeout(debounce);
    if (!hasIncompleteQualifier(q.value)) debounce = window.setTimeout(() => runSearch(false), 700);
  });
  const labelsByRepo = new Map<string, Promise<string[]>>();
  initSuggest(q, $('#qSuggest'), () => ({
    me: state.viewer?.login ?? '',
    authors: [...new Set(state.prs.map((p) => p.author?.login).filter((a): a is string => !!a))],
    branches: [...new Set(state.prs.flatMap((p) => [p.headRefName, p.baseRefName]))],
    labels: () => {
      const key = `${state.owner}/${state.repo}`.toLowerCase();
      if (!labelsByRepo.has(key)) labelsByRepo.set(key, fetchLabels(state.owner, state.repo));
      return labelsByRepo.get(key)!;
    },
  }), () => runSearch(true));

  document.querySelectorAll<HTMLElement>('.chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.chip = b.dataset.chip ?? '';
      document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      void loadPrs(true);
    }));

  document.querySelectorAll<HTMLElement>('.seg [data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      if (state.tab === b.dataset.tab) return;
      state.tab = b.dataset.tab as Tab;
      void loadPrs(true);
    }));

  $('#moreBtn').addEventListener('click', () =>
    void withBusy($<HTMLButtonElement>('#moreBtn'), () => loadPrs(false)));

  $('#list').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-act]');
    if (!btn) {
      // Tap anywhere else on a card: open its details.
      const card = target.closest<HTMLElement>('.pr');
      const pr = card && findPr(card.dataset.id);
      if (pr) void openDetails(pr);
      return;
    }
    const pr = findPr(btn.dataset.id);
    if (!pr) return;
    switch (btn.dataset.act) {
      case 'files': void openFiles(pr); break;
      case 'review': openReview(pr); break;
      case 'merge': void openMerge(pr); break;
      case 'details': void openDetails(pr, btn.dataset.section); break;
    }
  });
  $('#list').addEventListener('keydown', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.pr');
    if (!card || e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const pr = findPr(card.dataset.id);
    if (pr) void openDetails(pr);
  });

  $('#detailSheet').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const check = target.closest<HTMLElement>('[data-check]');
    if (check) return void toggleCheck(check.dataset.check ?? '');
    const act = target.closest<HTMLElement>('[data-dact]')?.dataset.dact;
    const pr = detail.data ?? detail.pr;
    if (!act || !pr) return;
    if (act === 'refresh') void loadDetails();
    else if (act === 'body') { detail.showFullBody = !detail.showFullBody; renderDetails(); }
    else if (act === 'files') void openFiles(pr);
    else if (act === 'review') openReview(pr);
    else if (act === 'merge') void openMerge(pr);
  });
  document.addEventListener('dialog:closed', (e) => {
    if ((e as CustomEvent<string>).detail === '#detailSheet') clearTimeout(detail.timer);
  });

  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-diag]')) void runDiagnostics();
  });
  $('#diagRerun').addEventListener('click', () => void runDiagnostics());
  $('#diagCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diagReport);
      toast('Report copied', 'ok');
    } catch {
      toast('Couldn’t copy. Select the text and copy it manually.', 'err');
    }
  });

  $('#reviewConfirm').addEventListener('click', () => void submitReview());
  $('#mergeConfirm').addEventListener('click', () => void confirmMerge());
  $('#filesMoreBtn').addEventListener('click', () => {
    if (!state.current) return;
    filesPage++;
    void withBusy($<HTMLButtonElement>('#filesMoreBtn'), () => loadFilesPage(state.current!));
  });

  registerServiceWorker();

  if (getToken()) void boot();
  else showLogin();
}

init();
