// Code view: browse any branch (or a PR's head commit) of the selected repository,
// folder by folder, and open files in a zoomable viewer.
import { graphql } from './api';
import { fetchBranches, fetchCode, type BranchList, type CodeObject, type TreeEntry } from './queries';
import { $, closeDialog, esc, icon, isDialogOpen, openDialog, renderBlob, safeUrl, timeAgo } from './ui';
import { initZoom } from './zoom';

export interface CodeContext {
  owner(): string;
  repo(): string;
  /** Opens a pull request's details by number. */
  openPr(number: number): void;
}

const code = {
  key: '',
  /** Branch name or commit SHA; '' until the default branch is known. */
  rev: '',
  /** Shown on the branch button, e.g. a branch name or "PR #12 head". */
  label: '',
  path: '',
  data: null as CodeObject | null,
  error: '',
  loading: false,
  seq: 0,
};

const branches = {
  key: '',
  list: null as BranchList | null,
  /** Server-side search results while typing. */
  remote: { q: '', list: null as BranchList | null, loading: false, error: '' },
  loading: false,
  error: '',
  timer: 0,
};

let ctx: CodeContext;

const repoKey = () => `${ctx.owner()}/${ctx.repo()}`.toLowerCase();

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const spinner = (text: string) => `<div class="picker-status" style="border:0"><span class="spinner"></span>${esc(text)}</div>`;

async function defaultBranch(owner: string, repo: string): Promise<string> {
  const data = await graphql<{ repository: { defaultBranchRef: { name: string } | null } | null }>(`
    query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name } } }`, { owner, name: repo });
  if (!data.repository) throw new Error(`Repository ${owner}/${repo} not found (or the token has no access to it).`);
  return data.repository.defaultBranchRef?.name ?? '';
}

/** Loads the current folder. Resets to the default branch when the repository changed. */
async function load(): Promise<void> {
  const owner = ctx.owner();
  const repo = ctx.repo();
  if (!owner || !repo) return;
  if (code.key !== repoKey()) {
    code.key = repoKey();
    code.rev = '';
    code.label = '';
    code.path = '';
  }
  const seq = ++code.seq;
  code.loading = true;
  code.error = '';
  render();
  try {
    if (!code.rev) {
      const name = await defaultBranch(owner, repo);
      if (seq !== code.seq) return;
      if (!name) throw new Error('This repository is empty.');
      code.rev = name;
      code.label = name;
    }
    const data = await fetchCode(owner, repo, code.rev, code.path);
    if (seq !== code.seq) return;
    code.data = data;
    if (!data.commit) code.error = `Branch “${code.label || code.rev}” not found. It may have been deleted.`;
    else if (!data.object) code.error = `“${code.path}” isn’t on ${code.label || code.rev}.`;
  } catch (e) {
    if (seq !== code.seq) return;
    const msg = (e as Error).message;
    code.data = null;
    code.error = /not accessible|Resource not accessible|403/i.test(msg)
      ? `${msg} Browsing code needs “Contents: Read” on the token.` : msg;
  }
  code.loading = false;
  render();
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const rank = (e: TreeEntry) => (e.type === 'tree' ? 0 : e.type === 'commit' ? 1 : 2);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** The open PR whose head is the current branch (from the branch list, if loaded). */
function branchPr(): { number: number; title: string } | null {
  const list = branches.key === repoKey() ? branches.list : null;
  return list?.branches.find((b) => b.name === code.rev)?.pr ?? null;
}

function render(): void {
  $('#branchLabel').textContent = code.label || code.rev || '…';
  const d = code.data;

  const pr = branchPr();
  $('#codePr').innerHTML = pr
    ? `<button class="code-pr" type="button" data-code-pr="${pr.number}">${icon('open', 'c-open')}<span><b>#${pr.number}</b> ${esc(pr.title)}</span>${icon('chev', 'chev')}</button>` : '';

  const c = d?.commit;
  $('#codeCommit').innerHTML = c ? `
    <a class="mono" href="${safeUrl(c.url)}" target="_blank" rel="noopener noreferrer" title="Open commit on GitHub">${esc(c.abbreviatedOid)}</a>
    <span class="code-commit-msg">${esc(c.messageHeadline)}</span>
    <span class="d-muted">${esc(c.author?.user?.login ?? c.author?.name ?? '')} · ${esc(timeAgo(c.committedDate, true))}</span>` : '';

  const parts = code.path ? code.path.split('/') : [];
  $('#codePath').innerHTML = [
    `<button type="button" data-code-path="">${icon('repo')}<b>${esc(ctx.repo())}</b></button>`,
    ...parts.map((p, i) => `<span class="sep">/</span><button type="button" data-code-path="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`),
  ].join('');

  const err = $('#codeError');
  err.textContent = code.error;
  err.classList.toggle('hidden', !code.error || code.loading);

  const tree = $('#codeTree');
  if (code.loading && !d) { tree.innerHTML = spinner('Loading files…'); return; }
  const obj = d?.object;
  if (!obj || obj.__typename !== 'Tree' || code.error) {
    tree.innerHTML = code.loading ? spinner('Loading files…')
      : code.error && code.path ? '<button class="btn btn-sm" type="button" data-code-path="">Go to the top folder</button>' : '';
    return;
  }
  const up = code.path ? `<button class="code-entry" type="button" data-code-path="${esc(parts.slice(0, -1).join('/'))}">${icon('dir', 'c-dir')}<span class="code-name">..</span></button>` : '';
  const rows = sortEntries(obj.entries).map((e) => {
    if (e.type === 'commit') {
      return `<div class="code-entry is-sub">${icon('repo', 'c-muted')}<span class="code-name">${esc(e.name)}</span><small class="d-muted">submodule</small></div>`;
    }
    const isDir = e.type === 'tree';
    return `<button class="code-entry" type="button" ${isDir ? `data-code-path="${esc(e.path)}"` : `data-code-file="${esc(e.path)}"`}>
      ${isDir ? icon('dir', 'c-dir') : icon('file', 'c-muted')}
      <span class="code-name">${esc(e.name)}</span>
      ${!isDir ? `<small class="d-muted">${esc(formatSize(e.object?.byteSize))}</small>` : ''}
    </button>`;
  }).join('');
  tree.innerHTML = `<div class="d-list${code.loading ? ' is-loading' : ''}">${up}${rows || '<p class="d-muted" style="padding:12px">This folder is empty.</p>'}</div>`;
}

// ---------- Branch picker ----------

async function loadBranches(): Promise<void> {
  const key = repoKey();
  if (branches.key === key && branches.list) return;
  branches.key = key;
  branches.list = null;
  branches.loading = true;
  branches.error = '';
  renderBranches();
  try {
    const list = await fetchBranches(ctx.owner(), ctx.repo());
    if (branches.key !== key) return;
    branches.list = list;
  } catch (e) {
    if (branches.key !== key) return;
    branches.error = (e as Error).message;
  }
  branches.loading = false;
  renderBranches();
  render(); // the branch's PR banner
}

function searchBranches(): void {
  clearTimeout(branches.timer);
  const q = $<HTMLInputElement>('#branchQ').value.trim();
  const list = branches.list;
  // Every branch is already loaded: filter locally.
  if (!q || !list || list.total <= list.branches.length) {
    branches.remote = { q: '', list: null, loading: false, error: '' };
    return renderBranches();
  }
  branches.remote = { q, list: null, loading: true, error: '' };
  renderBranches();
  const key = repoKey();
  branches.timer = window.setTimeout(async () => {
    let result: BranchList | null = null;
    let error = '';
    try { result = await fetchBranches(ctx.owner(), ctx.repo(), q); } catch (e) { error = (e as Error).message; }
    if (branches.remote.q !== q || branches.key !== key) return;
    branches.remote = { q, list: result, loading: false, error };
    renderBranches();
  }, 300);
}

function renderBranches(): void {
  $('#branchSub').textContent = `${ctx.owner()}/${ctx.repo()}${branches.list ? ` · ${branches.list.total} branch${branches.list.total === 1 ? '' : 'es'}` : ''}`;
  const q = $<HTMLInputElement>('#branchQ').value.trim().toLowerCase();
  const list = branches.list;
  const el = $('#branchList');
  if (!list) {
    el.innerHTML = branches.loading ? spinner('Loading branches…') : branches.error ? `<div class="error-box" style="margin:16px">${esc(branches.error)}</div>` : '';
    return;
  }
  const r = branches.remote;
  const source = r.q && r.list ? r.list.branches : list.branches;
  const shown = source.filter((b) => !q || b.name.toLowerCase().includes(q));
  // Default branch first, then the most recently committed.
  shown.sort((a, b) => Number(b.name === list.defaultBranch) - Number(a.name === list.defaultBranch));
  el.innerHTML = shown.map((b) => `
    <div class="picker-item" role="option" aria-selected="${b.name === code.rev}">
      <button class="pick" type="button" data-branch="${esc(b.name)}">
        ${icon('check', 'tick')}
        <b class="mono branch-name">${esc(b.name)}</b>
        ${b.name === list.defaultBranch ? '<span class="Label">default</span>' : '<span></span>'}
        <small>
          ${b.pr ? `<span class="c-open">${icon('open')} #${b.pr.number} ${esc(b.pr.title)}</span>` : ''}
          ${b.committedDate ? `<span>Updated ${esc(timeAgo(b.committedDate))}</span>` : ''}
        </small>
      </button>
    </div>`).join('')
    + (r.loading ? spinner('Searching branches…') : r.error ? `<div class="error-box" style="margin:12px 16px">${esc(r.error)}</div>` : '')
    + (!shown.length && !r.loading ? '<div class="picker-empty">No branches match.</div>' : '')
    + (!q && list.total > list.branches.length ? `<div class="picker-status">${icon('search')}Showing the ${list.branches.length} most recent of ${list.total}. Type to find others.</div>` : '');
}

function openBranches(): void {
  $<HTMLInputElement>('#branchQ').value = '';
  branches.remote = { q: '', list: null, loading: false, error: '' };
  renderBranches();
  openDialog('#branchSheet');
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => $('#branchQ').focus(), 50);
  void loadBranches();
}

// ---------- File viewer ----------

let blobSeq = 0;

/** Shows one file at `rev` (branch or SHA). `revLabel` names it in the header. */
export async function openBlob(owner: string, repo: string, rev: string, path: string, revLabel = rev): Promise<void> {
  const seq = ++blobSeq;
  const slash = path.lastIndexOf('/');
  $('#blobTitle').textContent = path.slice(slash + 1);
  $('#blobSub').textContent = `${slash > 0 ? `${path.slice(0, slash)}/ · ` : ''}${revLabel}`;
  $<HTMLAnchorElement>('#blobGitHub').href =
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${[rev, ...path.split('/')].map(encodeURIComponent).join('/')}`;
  const body = $('#blobBody');
  body.innerHTML = spinner('Loading file…');
  openDialog('#blobSheet');
  body.scrollTop = 0;
  try {
    const d = await fetchCode(owner, repo, rev, path);
    if (seq !== blobSeq) return;
    const b = d.object;
    if (!b || b.__typename !== 'Blob') {
      body.innerHTML = `<div class="diff-note">This file isn’t on ${esc(revLabel)}.</div>`;
      return;
    }
    const link = `<a href="${safeUrl($<HTMLAnchorElement>('#blobGitHub').href)}" target="_blank" rel="noopener noreferrer">View on GitHub</a>`;
    if (b.isBinary) {
      body.innerHTML = `<div class="diff-note">Binary file (${esc(formatSize(b.byteSize))}). ${link}</div>`;
      return;
    }
    if (b.text === null) {
      body.innerHTML = `<div class="diff-note">File too large to show (${esc(formatSize(b.byteSize))}). ${link}</div>`;
      return;
    }
    const lines = b.text.split('\n').length;
    body.innerHTML = `
      <div class="files-toolbar"><span>${lines} line${lines === 1 ? '' : 's'} · ${esc(formatSize(b.byteSize))}</span></div>
      <div class="file"><div class="diff-wrap"><table class="diff blob">${renderBlob(b.text)}</table></div></div>
      ${b.isTruncated ? `<div class="diff-note">Only the start of this file is shown. ${link}</div>` : ''}`;
  } catch (e) {
    if (seq !== blobSeq) return;
    body.innerHTML = `<div class="error-box">${esc((e as Error).message)}</div>`;
  }
}

// ---------- Public API ----------

export const codeView = {
  init(c: CodeContext): void {
    ctx = c;
    initZoom('#blobSheet', $('#blobTools'), $('#blobBody'));
    $('#branchBtn').addEventListener('click', openBranches);
    $('#branchQ').addEventListener('input', searchBranches);
    $('#branchQ').addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') document.querySelector<HTMLButtonElement>('#branchList .pick')?.click();
    });
    $('#branchList').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-branch]');
      if (!b) return;
      const name = b.dataset.branch ?? '';
      closeDialog('#branchSheet');
      // Same folder on the other branch, as on GitHub.
      code.rev = name;
      code.label = name;
      void load();
    });
    $('#codeView').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const dir = t.closest<HTMLElement>('[data-code-path]');
      if (dir) {
        code.path = dir.dataset.codePath ?? '';
        void load().then(() => scrollTo({ top: 0 }));
        return;
      }
      const file = t.closest<HTMLElement>('[data-code-file]');
      if (file) return void openBlob(ctx.owner(), ctx.repo(), code.rev, file.dataset.codeFile ?? '', code.label || code.rev);
      const pr = t.closest<HTMLElement>('[data-code-pr]');
      if (pr) ctx.openPr(Number(pr.dataset.codePr));
    });
  },

  /** Shows the view; loads it when the repository changed or `reload` is set. */
  show(reload = false): void {
    if (reload || code.key !== repoKey() || (!code.data && !code.loading)) void load();
    else render();
    // The branch list tells which branch has an open PR.
    if (branches.key !== repoKey() && !isDialogOpen('#branchSheet')) void loadBranches();
  },

  /** Opens `rev` (a branch name or SHA) of the current repository. */
  browse(rev: string, label = rev, path = ''): void {
    code.key = repoKey();
    code.rev = rev;
    code.label = label;
    code.path = path;
    void load();
    if (branches.key !== repoKey()) void loadBranches();
  },
};
