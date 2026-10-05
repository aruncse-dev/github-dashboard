// Thin GitHub client. The token lives only in this browser's localStorage and is sent
// only to api.github.com (the production CSP enforces that too).

const API = 'https://api.github.com';
const TOKEN_KEY = 'gh_pr_token';

export const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage blocked: keep working in-memory */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export const getToken = (): string | null => storage.get(TOKEN_KEY);
export const saveToken = (token: string): void => storage.set(TOKEN_KEY, token);
export const forgetToken = (): void => storage.remove(TOKEN_KEY);

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface ErrorBody {
  message?: string;
  errors?: Array<{ message?: string; code?: string; field?: string } | string>;
}

function describeError(status: number, body: ErrorBody | null): string {
  const base = body?.message ?? `GitHub returned HTTP ${status}`;
  const details = (body?.errors ?? [])
    .map((e) => (typeof e === 'string' ? e : e.message ?? [e.field, e.code].filter(Boolean).join(' ')))
    .filter(Boolean);
  let msg = details.length ? `${base}: ${details.join('; ')}` : base;
  if (status === 401) msg = 'Bad credentials: the token is invalid, expired or revoked.';
  else if (/SAML|SSO/i.test(msg)) msg += ' (Authorize this token for the organization’s SSO under GitHub → Settings → Tokens.)';
  else if (status === 404) msg += ' (or the token has no access to it)';
  return msg;
}

async function request<T>(path: string, init: RequestInit = {}, token: string | null = getToken()): Promise<T> {
  if (!token) throw new GitHubError('No token saved', 401);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
  };
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { ...init, headers, cache: 'no-store' });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const sso = ssoUrl(res);
    const msg = sso ? `This organization uses SAML SSO. Authorize the token here: ${sso}` : describeError(res.status, body);
    throw new GitHubError(msg, res.status);
  }
  return body as T;
}

/** GitHub sends `X-GitHub-SSO: required; url=…` when the token isn't authorized for an SSO org. */
function ssoUrl(res: Response): string | null {
  const h = res.headers.get('x-github-sso');
  return h?.match(/url=([^\s;]+)/)?.[1] ?? null;
}

export const isFineGrained = (token: string | null = getToken()): boolean => !!token?.startsWith('github_pat_');

export interface ProbeResult {
  ok: boolean;
  status: number;
  body: unknown;
  message: string;
  scopes: string | null;
  sso: string | null;
}

/** Like `request`, but never throws: used by the token check. */
export async function probe(path: string, init: RequestInit = {}, token: string | null = getToken()): Promise<ProbeResult> {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
    if (init.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + path, { ...init, headers, cache: 'no-store' });
    const body = await res.json().catch(() => null);
    const gqlErrors = (body as { errors?: Array<{ message: string }> } | null)?.errors;
    const ok = res.ok && !gqlErrors?.length;
    const sso = ssoUrl(res) ?? res.headers.get('x-github-sso');
    const message = ok ? 'OK'
      : gqlErrors?.length ? gqlErrors.map((e) => e.message).join('; ')
      : describeError(res.status, body as ErrorBody | null);
    return { ok, status: res.status, body, message, scopes: res.headers.get('x-oauth-scopes'), sso };
  } catch (e) {
    return { ok: false, status: 0, body: null, message: (e as Error).message, scopes: null, sso: null };
  }
}

// ---------- GraphQL ----------

let onWarning: (msg: string) => void = (msg) => console.warn(msg);
export function setWarningHandler(fn: (msg: string) => void): void {
  onWarning = fn;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string; type?: string; path?: Array<string | number> }>;
}

/**
 * GitHub returns `null` in a connection's `nodes` for items the token may not read
 * (e.g. check runs for fine-grained tokens). Drop them, keep `totalCount` in step and
 * record how many were dropped in `hiddenCount`.
 */
function dropHidden<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropHidden) as T;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) obj[key] = dropHidden(obj[key]);
    if (Array.isArray(obj.nodes)) {
      const before = obj.nodes.length;
      obj.nodes = obj.nodes.filter((n) => n !== null);
      const hidden = before - (obj.nodes as unknown[]).length;
      if (hidden && typeof obj.totalCount === 'number') obj.totalCount = Math.max(0, obj.totalCount - hidden);
      if (hidden) obj.hiddenCount = hidden;
    }
  }
  return value;
}

const CHECK_FIELDS = new Set(['statusCheckRollup', 'contexts', 'checkSuite', 'checks']);
const isCheckFieldError = (e: { path?: Array<string | number> }) => !!e.path?.some((p) => CHECK_FIELDS.has(String(p)));

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}, quiet = false): Promise<T> {
  const res = await request<GraphQLResponse<T>>('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  const errors = res.errors ?? [];
  if (!res.data) {
    throw new GitHubError(describeError(200, { message: errors.map((e) => e.message).join('; ') || 'GraphQL error' }), 200);
  }
  // Partial data (e.g. one SAML-protected org hidden from search results): still show what we got.
  const relevant = errors.filter((e) => !isCheckFieldError(e));
  if (relevant.length && !quiet) onWarning(describeError(200, { message: relevant[0].message }));
  return dropHidden(res.data);
}

// ---------- REST ----------

export interface RestUser {
  login: string;
  avatar_url: string;
}

export interface RestPull {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

export interface RestFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

const repoPath = (owner: string, repo: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export interface RestRepo {
  name: string;
  owner: { login: string; type: string; avatar_url: string };
  description: string | null;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  language: string | null;
}

export const rest = {
  /** Validates a token before it is saved. */
  user: (token: string) => request<RestUser>('/user', {}, token),

  /** Repos the token can reach. For fine-grained tokens this is exactly the selected repos. */
  userRepos: () => request<RestRepo[]>('/user/repos?per_page=100&sort=pushed'),

  userOrgs: () => request<Array<{ login: string; avatar_url: string }>>('/user/orgs?per_page=100'),

  /** Workflow runs (Actions: Read). `sha` narrows to one commit; empty = most recent runs. */
  workflowRuns: (owner: string, repo: string, sha: string) =>
    request<{ workflow_runs: import('./actions').WorkflowRun[] }>(
      `${repoPath(owner, repo)}/actions/runs?per_page=100${sha ? `&head_sha=${encodeURIComponent(sha)}` : ''}`),

  runJobs: (owner: string, repo: string, runId: number) =>
    request<{ jobs: import('./actions').Job[] }>(`${repoPath(owner, repo)}/actions/runs/${runId}/jobs?per_page=100`),

  pull: (owner: string, repo: string, n: number) =>
    request<RestPull>(`${repoPath(owner, repo)}/pulls/${n}`),

  files: (owner: string, repo: string, n: number, page: number) =>
    request<RestFile[]>(`${repoPath(owner, repo)}/pulls/${n}/files?per_page=100&page=${page}`),

  review: (owner: string, repo: string, n: number, event: ReviewEvent, body: string) =>
    request<unknown>(`${repoPath(owner, repo)}/pulls/${n}/reviews`, {
      method: 'POST',
      body: JSON.stringify(body ? { event, body } : { event }),
    }),

  /** `sha` makes GitHub refuse the merge if the branch moved since we looked at it. */
  merge: (owner: string, repo: string, n: number, method: MergeMethod, sha: string) =>
    request<{ merged: boolean; message: string }>(`${repoPath(owner, repo)}/pulls/${n}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: method, sha }),
    }),
};
