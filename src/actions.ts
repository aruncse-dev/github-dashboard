// GitHub Actions results via the Actions REST API.
// Fine-grained tokens have no "Checks" permission, so check runs (how Actions results usually
// arrive) are unreadable; workflow runs and jobs are readable with "Actions: Read".
import { rest } from './api';
import type { CheckBucket } from './queries';

export interface WorkflowRun {
  id: number;
  name: string | null;
  workflow_id: number;
  event: string;
  head_sha: string;
  status: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion: string | null;
  run_number: number;
  run_attempt?: number;
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

/** Keep only the newest run of each workflow and event (re-runs replace earlier ones), as GitHub's checks list does. */
export function latestPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const byWorkflow = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const key = `${r.workflow_id}:${r.event}`;
    const prev = byWorkflow.get(key);
    if (!prev || r.run_number > prev.run_number || (r.run_number === prev.run_number && r.created_at > prev.created_at)) byWorkflow.set(key, r);
  }
  return [...byWorkflow.values()];
}

/** Jobs of finished run attempts never change, so they are fetched once. */
const finishedJobs = new Map<string, Job[]>();

async function runJobs(owner: string, repo: string, run: WorkflowRun): Promise<Job[]> {
  const key = `${owner}/${repo}#${run.id}.${run.run_attempt ?? 1}`;
  const cached = finishedJobs.get(key);
  if (cached) return cached;
  const jobs = (await rest.runJobs(owner, repo, run.id)).jobs;
  if (run.status === 'completed') finishedJobs.set(key, jobs);
  return jobs;
}

/**
 * Jobs of every run for one commit (each job is one check on GitHub). A commit can have several
 * runs of one workflow, e.g. jobs still running in one while a newer run waits in "setup", so like
 * GitHub's checks list keep the newest job per workflow, event and name rather than the newest run.
 */
export async function actionsForCommit(owner: string, repo: string, sha: string): Promise<{ runs: WorkflowRun[]; jobs: Job[] }> {
  const runs = (await rest.workflowRuns(owner, repo, sha)).workflow_runs;
  const jobLists = await Promise.all(runs.map((r) => runJobs(owner, repo, r)
    .then((jobs) => jobs.map((j) => ({ job: j, run: r })))
    .catch(() => [])));
  const latest = new Map<string, { job: Job; run: WorkflowRun }>();
  for (const e of jobLists.flat()) {
    const key = [e.run.workflow_id, e.run.event, e.job.name].join('\u0000');
    const prev = latest.get(key);
    const newer = !prev || e.run.run_number > prev.run.run_number
      || (e.run.run_number === prev.run.run_number && (e.run.run_attempt ?? 1) > (prev.run.run_attempt ?? 1))
      || (e.run.id === prev.run.id && e.job.id > prev.job.id);
    if (newer) latest.set(key, e);
  }
  return { runs: latestPerWorkflow(runs), jobs: [...latest.values()].map((e) => e.job) };
}
