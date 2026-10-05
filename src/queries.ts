import { graphql, rest, type RestRepo } from './api';

// ---------- Types (only the fields we query) ----------

export interface Viewer {
  login: string;
  avatarUrl: string;
  organizations: { nodes: Array<{ login: string; avatarUrl: string }> };
}

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipped';

export interface CheckContext {
  __typename: 'CheckRun' | 'StatusContext';
  // CheckRun
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  // StatusContext
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string;
  baseRefName: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: { login: string; avatarUrl: string } | null;
  repository: {
    name: string;
    owner: { login: string };
    /** ADMIN | MAINTAIN | WRITE | TRIAGE | READ (null if unknown) */
    viewerPermission: string | null;
  };
  viewerLatestReview: { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' } | null;
  comments: { totalCount: number };
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { __typename: string; login?: string; slug?: string } | null }>;
  } | null;
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: {
          state: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED';
          contexts: { totalCount: number; nodes: CheckContext[] };
        } | null;
      };
    }>;
  };
}

export interface Repo {
  name: string;
  owner: { login: string };
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  pushedAt: string | null;
  primaryLanguage: { name: string; color: string | null } | null;
  pullRequests: { totalCount: number };
}

export interface MergeSettings {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  viewerDefaultMergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
}

// ---------- Queries ----------

const PR_FIELDS = `
  fragment PR on PullRequest {
    id number title url state isDraft createdAt updatedAt mergedAt closedAt
    headRefName baseRefName mergeable reviewDecision
    author { login avatarUrl(size: 48) }
    repository { name owner { login } viewerPermission }
    viewerLatestReview { state }
    comments { totalCount }
    reviewRequests(first: 10) {
      nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
    }
    commits(last: 1) {
      nodes {
        commit {
          oid
          statusCheckRollup {
            state
            contexts(first: 50) {
              totalCount
              nodes {
                __typename
                ... on CheckRun { name status conclusion detailsUrl }
                ... on StatusContext { context state targetUrl }
              }
            }
          }
        }
      }
    }
  }`;

export const PAGE_SIZE = 10;

/** Repos the token can reach (REST). Shared by the org and repo fallbacks below. */
let tokenReposPromise: Promise<RestRepo[]> | null = null;
export function tokenRepos(refresh = false): Promise<RestRepo[]> {
  if (!tokenReposPromise || refresh) {
    tokenReposPromise = rest.userRepos().catch(() => []);
  }
  return tokenReposPromise;
}

/**
 * Signed-in user plus their organizations. Fine-grained tokens often can't list orgs,
 * so fall back to REST /user/orgs, then to the owners of repos the token can reach.
 */
export async function fetchViewer(refresh = false): Promise<Viewer> {
  const base = await graphql<{ viewer: { login: string; avatarUrl: string } }>(`query { viewer { login avatarUrl(size: 64) } }`);
  let orgs: Array<{ login: string; avatarUrl: string }> = [];
  try {
    const data = await graphql<{ viewer: { organizations: { nodes: Array<{ login: string; avatarUrl: string }> } } }>(
      `query { viewer { organizations(first: 100) { nodes { login avatarUrl(size: 40) } } } }`, {}, true);
    orgs = data.viewer.organizations.nodes.filter(Boolean);
  } catch { /* not allowed for this token */ }
  if (!orgs.length) {
    try {
      orgs = (await rest.userOrgs()).map((o) => ({ login: o.login, avatarUrl: o.avatar_url }));
    } catch { /* not allowed for this token */ }
  }
  if (!orgs.length) {
    const seen = new Map<string, string>();
    for (const r of await tokenRepos(refresh)) {
      if (r.owner.login.toLowerCase() !== base.viewer.login.toLowerCase()) seen.set(r.owner.login, r.owner.avatar_url);
    }
    orgs = [...seen].map(([login, avatarUrl]) => ({ login, avatarUrl }));
  }
  return { ...base.viewer, organizations: { nodes: orgs } };
}

export interface SearchResult {
  openCount: number;
  closedCount: number;
  prs: PullRequest[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** `scope` is everything except the is:open / is:closed part, e.g. "org:acme review:approved". */
export async function searchPullRequests(scope: string, state: 'open' | 'closed', after: string | null): Promise<SearchResult> {
  const q = (s: string) => `is:pr is:${s} archived:false ${scope} sort:updated-desc`;
  const data = await graphql<{
    open: { issueCount: number };
    closed: { issueCount: number };
    results: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<PullRequest | Record<string, never>> };
  }>(`
    query($q: String!, $qOpen: String!, $qClosed: String!, $after: String, $first: Int!) {
      open: search(query: $qOpen, type: ISSUE, first: 1) { issueCount }
      closed: search(query: $qClosed, type: ISSUE, first: 1) { issueCount }
      results: search(query: $q, type: ISSUE, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...PR }
      }
    }
    ${PR_FIELDS}`,
    { q: q(state), qOpen: q('open'), qClosed: q('closed'), after, first: PAGE_SIZE });
  return {
    openCount: data.open.issueCount,
    closedCount: data.closed.issueCount,
    // Nodes the token cannot see (e.g. SSO-protected) come back empty or null.
    prs: data.results.nodes.filter((n): n is PullRequest => !!n && 'id' in n),
    hasNextPage: data.results.pageInfo.hasNextPage,
    endCursor: data.results.pageInfo.endCursor,
  };
}

// ---------- PR details (opened from a card) ----------

export interface DetailCheck {
  __typename: 'CheckRun' | 'StatusContext';
  id: string;
  // CheckRun
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun: { workflow: { name: string } } | null } | null;
  // StatusContext
  context?: string;
  state?: string;
  description?: string | null;
  targetUrl?: string | null;
  createdAt?: string;
}

export interface PullRequestDetail extends PullRequest {
  bodyText: string;
  bodyHTML: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: { nodes: Array<{ name: string; color: string }> } | null;
  latestReviews: { nodes: Array<{ author: { login: string } | null; state: string; submittedAt: string | null }> } | null;
  commitsCount: { totalCount: number };
  recentCommits: {
    nodes: Array<{ commit: { abbreviatedOid: string; messageHeadline: string; committedDate: string; author: { name: string | null; user: { login: string } | null } | null } }>;
  };
  recentComments: { totalCount: number; nodes: Array<{ author: { login: string } | null; bodyText: string; bodyHTML: string; createdAt: string }> };
  checks: {
    nodes: Array<{ commit: { statusCheckRollup: { state: string; contexts: { totalCount: number; nodes: DetailCheck[] } } | null } }>;
  };
}

export interface CheckRunDetail {
  title: string | null;
  summary: string | null;
  text: string | null;
  annotations: {
    totalCount: number;
    nodes: Array<{ path: string; annotationLevel: string | null; message: string; title: string | null; location: { start: { line: number } } }>;
  } | null;
}

export async function fetchPullRequestDetail(id: string): Promise<PullRequestDetail | null> {
  const data = await graphql<{ node: PullRequestDetail | null }>(`
    query($id: ID!) {
      node(id: $id) {
        ... on PullRequest {
          ...PR
          bodyText bodyHTML additions deletions changedFiles
          labels(first: 20) { nodes { name color } }
          latestReviews(first: 20) { nodes { author { login } state submittedAt } }
          commitsCount: commits { totalCount }
          recentCommits: commits(last: 5) {
            nodes { commit { abbreviatedOid messageHeadline committedDate author { name user { login } } } }
          }
          recentComments: comments(last: 10) { totalCount nodes { author { login } bodyText bodyHTML createdAt } }
          checks: commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(first: 100) {
                    totalCount
                    nodes {
                      __typename
                      ... on CheckRun {
                        id name status conclusion startedAt completedAt detailsUrl
                        checkSuite { workflowRun { workflow { name } } }
                      }
                      ... on StatusContext { id context state description targetUrl createdAt }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    ${PR_FIELDS}`, { id });
  return data.node;
}

/** Output of one check run: GitHub's summary plus error/warning annotations. */
export async function fetchCheckRunDetail(id: string): Promise<CheckRunDetail | null> {
  const data = await graphql<{ node: CheckRunDetail | null }>(`
    query($id: ID!) {
      node(id: $id) {
        ... on CheckRun {
          title summary text
          annotations(first: 30) {
            totalCount
            nodes { path annotationLevel message title location { start { line } } }
          }
        }
      }
    }`, { id });
  return data.node;
}

export async function fetchPullRequest(id: string): Promise<PullRequest | null> {
  const data = await graphql<{ node: PullRequest | null }>(`
    query($id: ID!) { node(id: $id) { ...PR } }
    ${PR_FIELDS}`, { id });
  return data.node;
}

const REPO_FIELDS = `
  name description isPrivate isArchived pushedAt
  owner { login }
  primaryLanguage { name color }
  pullRequests(states: OPEN) { totalCount }`;

const notArchived = (r: Repo | null | undefined): r is Repo => !!r && !r.isArchived;

/** The owner's most recently pushed repos: one fast request, used for the picker's default list. */
export async function fetchRecentRepos(owner: string, count = 30): Promise<Repo[]> {
  let repos: Repo[] = [];
  try {
    const data = await graphql<{ repositoryOwner: { repositories: { nodes: Repo[] } } | null }>(`
      query($login: String!, $count: Int!) {
        repositoryOwner(login: $login) {
          repositories(first: $count, ownerAffiliations: [OWNER], orderBy: { field: PUSHED_AT, direction: DESC }) {
            nodes { ${REPO_FIELDS} }
          }
        }
      }`, { login: owner, count }, true);
    repos = (data.repositoryOwner?.repositories.nodes ?? []).filter(notArchived);
  } catch { /* fall back to REST below */ }
  if (repos.length) return repos;
  // Fine-grained tokens: the REST list holds exactly the repos selected for the token.
  const fromToken = (await tokenRepos())
    .filter((r) => r.owner.login.toLowerCase() === owner.toLowerCase() && !r.archived)
    .slice(0, count)
    .map((r): Repo => ({
      name: r.name,
      owner: { login: r.owner.login },
      description: r.description,
      isPrivate: r.private,
      isArchived: r.archived,
      pushedAt: r.pushed_at,
      primaryLanguage: r.language ? { name: r.language, color: null } : null,
      pullRequests: { totalCount: -1 }, // unknown via this API
    }));
  return fromToken;
}

/** Server-side repo search within one owner (matches the repo name). */
export async function searchRepos(owner: string, text: string): Promise<Repo[]> {
  const clean = text.replace(/["\\]/g, ' ').trim();
  const data = await graphql<{ search: { nodes: Array<Repo | Record<string, never>> } }>(`
    query($q: String!) {
      search(query: $q, type: REPOSITORY, first: 25) {
        nodes { ... on Repository { ${REPO_FIELDS} } }
      }
    }`, { q: `user:${owner} ${clean} in:name archived:false fork:true sort:updated-desc` });
  return data.search.nodes
    .filter((n): n is Repo => !!n && 'name' in n)
    .filter((r) => notArchived(r) && r.owner.login.toLowerCase() === owner.toLowerCase());
}

/** Labels of one repository (for search suggestions). */
export async function fetchLabels(owner: string, name: string): Promise<string[]> {
  const data = await graphql<{ repository: { labels: { nodes: Array<{ name: string }> } | null } | null }>(`
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name } } }
    }`, { owner, name });
  return data.repository?.labels?.nodes.map((l) => l.name) ?? [];
}

export async function fetchMergeSettings(owner: string, name: string): Promise<MergeSettings | null> {
  const data = await graphql<{ repository: MergeSettings | null }>(`
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
      }
    }`, { owner, name });
  return data.repository;
}

// ---------- Check helpers ----------

export function checkBucket(c: CheckContext): CheckBucket {
  if (c.__typename === 'StatusContext') {
    if (c.state === 'SUCCESS') return 'pass';
    if (c.state === 'FAILURE' || c.state === 'ERROR') return 'fail';
    return 'pending';
  }
  if (c.status !== 'COMPLETED') return 'pending';
  switch (c.conclusion) {
    case 'SUCCESS': return 'pass';
    case 'NEUTRAL':
    case 'SKIPPED': return 'skipped';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'CANCELLED':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
    case 'STALE': return 'fail';
    default: return 'pending';
  }
}

export interface CheckSummary {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  skipped: number;
  overall: 'pass' | 'fail' | 'pending' | 'none';
  items: Array<{ name: string; url: string | null; bucket: CheckBucket; fromCheckRun?: boolean }>;
}

export function summarizeChecks(pr: PullRequest): CheckSummary {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  const s: CheckSummary = { total: 0, pass: 0, fail: 0, pending: 0, skipped: 0, overall: 'none', items: [] };
  if (!rollup) return s;
  for (const c of rollup.contexts.nodes) {
    const bucket = checkBucket(c);
    s[bucket]++;
    s.items.push({
      name: c.__typename === 'CheckRun' ? c.name ?? 'check' : c.context ?? 'status',
      url: (c.__typename === 'CheckRun' ? c.detailsUrl : c.targetUrl) ?? null,
      bucket,
      fromCheckRun: c.__typename === 'CheckRun',
    });
  }
  s.total = rollup.contexts.totalCount;
  s.overall = s.fail ? 'fail' : s.pending ? 'pending' : rollup.state === 'SUCCESS' || s.pass ? 'pass' : 'pending';
  const order: Record<CheckBucket, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
  s.items.sort((a, b) => order[a.bucket] - order[b.bucket] || a.name.localeCompare(b.name));
  return s;
}
