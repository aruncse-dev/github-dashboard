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
  if (!res.ok) throw new GitHubError(describeError(res.status, body), res.status);
  return body as T;
}

// ---------- GraphQL ----------

let onWarning: (msg: string) => void = (msg) => console.warn(msg);
export function setWarningHandler(fn: (msg: string) => void): void {
  onWarning = fn;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string; type?: string }>;
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await request<GraphQLResponse<T>>('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  const errors = res.errors ?? [];
  if (!res.data) {
    throw new GitHubError(describeError(200, { message: errors.map((e) => e.message).join('; ') || 'GraphQL error' }), 200);
  }
  // Partial data (e.g. one SAML-protected org hidden from search results): still show what we got.
  if (errors.length) onWarning(describeError(200, { message: errors[0].message }));
  return res.data;
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

export const rest = {
  /** Validates a token before it is saved. */
  user: (token: string) => request<RestUser>('/user', {}, token),

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
