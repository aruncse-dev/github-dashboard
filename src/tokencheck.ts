// Checks a token against the app's minimum requirements before it is saved.
import { isFineGrained, probe } from './api';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info' | 'running';

export interface Requirement {
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to change on the token when this isn't met. */
  fix?: string;
}

export interface TokenCheckResult {
  /** False when a required item failed: the token must not be saved. */
  ok: boolean;
  items: Requirement[];
}

const enc = encodeURIComponent;

export async function checkToken(token: string, onProgress: (items: Requirement[]) => void): Promise<TokenCheckResult> {
  const items: Requirement[] = [];
  const push = (item: Requirement) => { items.push(item); onProgress([...items]); };
  const running = (label: string) => onProgress([...items, { label, status: 'running', detail: 'Checking…' }]);
  const done = (): TokenCheckResult => ({ ok: !items.some((i) => i.status === 'fail'), items });

  // 1. Valid at all?
  running('Token is valid');
  const user = await probe('/user', {}, token);
  if (!user.ok) {
    push({ label: 'Token is valid', status: 'fail', detail: user.message, fix: 'Check you pasted the whole token, and that it isn’t expired or revoked.' });
    return done();
  }
  const login = (user.body as { login?: string }).login ?? '';
  const fine = isFineGrained(token);
  push({ label: 'Token is valid', status: 'pass', detail: `Signed in as ${login} · ${fine ? 'fine-grained token' : 'classic token'}` });

  // 2a. Classic tokens: scopes are visible, so the check is exact.
  if (!fine && user.scopes !== null) {
    const scopes = user.scopes.split(',').map((x) => x.trim()).filter(Boolean);
    const has = (s: string) => scopes.includes(s);
    push(has('repo')
      ? { label: 'Repository access (repo scope)', status: 'pass', detail: 'Covers pull requests, checks, reviews and merging' }
      : { label: 'Repository access (repo scope)', status: 'fail', detail: `Scopes: ${scopes.join(', ') || 'none'}`, fix: 'Edit the token and tick the “repo” scope.' });
    push(has('read:org') || has('admin:org')
      ? { label: 'List organizations (read:org)', status: 'pass', detail: 'Org picker lists your organizations' }
      : { label: 'List organizations (read:org)', status: 'warn', detail: 'Optional. Without it the app finds orgs from your repositories.', fix: 'Tick “read:org” to list all your organizations.' });
    return done();
  }

  // 2b. Fine-grained tokens: permissions can't be read, so test them on a repository the token can reach.
  running('Reaches at least one repository');
  const repos = await probe('/user/repos?per_page=100&sort=pushed', {}, token);
  const list = Array.isArray(repos.body)
    ? (repos.body as Array<{ full_name: string; name: string; private: boolean; owner: { login: string }; default_branch: string }>) : [];
  if (!repos.ok || !list.length) {
    push({ label: 'Reaches at least one repository', status: 'fail', detail: repos.ok ? 'No repositories' : repos.message,
      fix: 'Under “Repository access” select the repositories you need. If your organization approves fine-grained tokens, ask an org owner to approve it (Organization → Settings → Personal access tokens → Pending requests).' });
    return done();
  }
  push({ label: 'Reaches at least one repository', status: 'pass', detail: `${list.length}: ${list.slice(0, 4).map((r) => r.full_name).join(', ')}${list.length > 4 ? '…' : ''}` });

  // Public repos are readable by any token, so only a private repo proves the permissions.
  const repo = list.find((r) => r.private) ?? list[0];
  const publicOnly = !repo.private;
  const base = `/repos/${enc(repo.owner.login)}/${enc(repo.name)}`;
  const where = `Tested on ${repo.full_name}${publicOnly ? ' (public repository: permissions can’t be fully verified)' : ''}`;

  running('Pull requests: Read');
  const pulls = await probe(`${base}/pulls?state=all&per_page=1`, {}, token);
  if (!pulls.ok) {
    push({ label: 'Pull requests: Read', status: 'fail', detail: pulls.message, fix: 'Set “Pull requests” to Read (or Read and write to approve).' });
    return done();
  }
  push({ label: 'Pull requests: Read', status: publicOnly ? 'info' : 'pass', detail: where });

  // A commit to test status/check access: latest PR head, else the default branch.
  const first = (pulls.body as Array<{ head: { sha: string } }>)[0];
  const ref = first?.head.sha ?? repo.default_branch;

  running('Commit statuses: Read');
  const status = await probe(`${base}/commits/${enc(ref)}/status`, {}, token);
  if (status.ok) push({ label: 'Commit statuses: Read', status: publicOnly ? 'info' : 'pass', detail: publicOnly ? where : 'CI status shows on cards' });
  else if (status.status === 403) push({ label: 'Commit statuses: Read', status: 'fail', detail: status.message, fix: 'Set “Commit statuses” to Read.' });
  else push({ label: 'Commit statuses: Read', status: 'info', detail: `Couldn’t test on ${repo.full_name} (${status.message})` });

  // Fine-grained tokens have no "Checks" permission; GitHub Actions results come from the Actions API.
  running('Actions: Read');
  const actions = await probe(`${base}/actions/runs?per_page=1`, {}, token);
  if (actions.ok) push({ label: 'Actions: Read', status: publicOnly ? 'info' : 'pass', detail: publicOnly ? where : 'GitHub Actions jobs and steps' });
  else if (actions.status === 403) push({ label: 'Actions: Read', status: 'warn', detail: 'Recommended. Without it GitHub Actions results won’t show (fine-grained tokens can’t read check runs).', fix: 'Set “Actions” to Read.' });
  else push({ label: 'Actions: Read', status: 'info', detail: `Couldn’t test on ${repo.full_name} (${actions.message})` });

  if (fine) push({ label: 'Checks from GitHub Apps', status: 'info', detail: 'Not available with fine-grained tokens: GitHub offers no “Checks” permission for them, so checks created by apps such as Semgrep stay hidden. GitHub Actions jobs and commit statuses still show. Use a classic token (repo scope) to see every check.' });
  push({ label: 'Approve / comment', status: 'info', detail: 'Needs “Pull requests: Read and write”. GitHub doesn’t let apps verify write access of fine-grained tokens.' });
  push({ label: 'Merge', status: 'info', detail: 'Needs “Contents: Read and write” (only if you merge from the app).' });
  return done();
}
