// GitHub Actions results via the Actions REST API.
// Fine-grained tokens have no "Checks" permission, so check runs (how Actions results usually
// arrive) are unreadable; workflow runs and jobs are readable with "Actions: Read".
import { rest } from './api';
import type { CheckBucket } from './queries';

export interface WorkflowRun {
  id: number;
  name: string | null;
  workflow_id: number;
  head_sha: string;
  status: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion: string | null;
  run_number: number;
  html_url: string;
  created_at: string;
}

export interface JobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface Job {
  id: number;
  run_id: number;
  name: string;
  workflow_name: string | null;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  steps?: JobStep[];
}

export function actionsBucket(status: string, conclusion: string | null): CheckBucket {
  if (status !== 'completed') return 'pending';
  switch (conclusion) {
    case 'success': return 'pass';
    case 'skipped':
    case 'neutral': return 'skipped';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
    case 'stale': return 'fail';
    default: return 'pending';
  }
}

export function actionsText(status: string, conclusion: string | null): string {
  if (status !== 'completed') {
    return ({ queued: 'Queued', in_progress: 'Running', waiting: 'Waiting', requested: 'Requested', pending: 'Pending' } as Record<string, string>)[status] ?? 'Pending';
  }
  return ({ success: 'Passed', failure: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', timed_out: 'Timed out',
    neutral: 'Neutral', action_required: 'Action required', startup_failure: 'Startup failure', stale: 'Stale' } as Record<string, string>)[conclusion ?? ''] ?? 'Done';
}

/** Keep only the newest run of each workflow (re-runs replace earlier ones). */
export function latestPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const byWorkflow = new Map<number, WorkflowRun>();
  for (const r of runs) {
    const prev = byWorkflow.get(r.workflow_id);
    if (!prev || r.run_number > prev.run_number || (r.run_number === prev.run_number && r.created_at > prev.created_at)) byWorkflow.set(r.workflow_id, r);
  }
  return [...byWorkflow.values()];
}

/** Recent runs of a repository grouped by commit SHA (one request, used for the PR cards). */
export async function runsByCommit(owner: string, repo: string): Promise<Map<string, WorkflowRun[]>> {
  const res = await rest.workflowRuns(owner, repo, '');
  const map = new Map<string, WorkflowRun[]>();
  for (const r of res.workflow_runs) map.set(r.head_sha, [...(map.get(r.head_sha) ?? []), r]);
  for (const [sha, runs] of map) map.set(sha, latestPerWorkflow(runs));
  return map;
}

/** Runs for one commit and the jobs (with steps) of each: used by the PR details sheet. */
export async function actionsForCommit(owner: string, repo: string, sha: string): Promise<{ runs: WorkflowRun[]; jobs: Job[] }> {
  const runs = latestPerWorkflow((await rest.workflowRuns(owner, repo, sha)).workflow_runs);
  const jobLists = await Promise.all(runs.map((r) => rest.runJobs(owner, repo, r.id).then((j) => j.jobs).catch(() => [] as Job[])));
  return { runs, jobs: jobLists.flat() };
}
