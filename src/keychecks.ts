// "Key checks" per repository: the checks that decide a card's pass/fail count.
// E.g. orion → "orion-test", rigel → "npm test". Stored per browser, like favourites.
import { storage } from './api';

const KEY = 'gh_pr_keychecks_v1';

type Store = Record<string, string[]>;

function read(): Store {
  try {
    const v = JSON.parse(storage.get(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

let data = read();
const save = () => storage.set(KEY, JSON.stringify(data));
const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** Splits "orion-test, lint" into clean terms. */
export function parseTerms(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean))];
}

function termMatcher(term: string): (s: string) => boolean {
  const t = term.toLowerCase();
  if (!t.includes('*')) return (s) => s.toLowerCase().includes(t);
  // "*" is a wildcard; the rest is literal. Anchored, so "test*" means "starts with test".
  const re = new RegExp(`^${t.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return (s) => re.test(s);
}

export interface CheckNames {
  /** Check run / job name, or a commit status context. */
  name: string;
  /** Workflow name of an Actions job, if any. */
  workflow?: string | null;
}

/** Text forms a term may match: the name, the workflow, and "workflow / name" as GitHub shows it. */
const forms = (c: CheckNames) => [c.name, ...(c.workflow ? [c.workflow, `${c.workflow} / ${c.name}`] : [])];

export const keyChecks = {
  terms(owner: string, repo: string): string[] {
    return [...(data[repoKey(owner, repo)] ?? [])];
  },
  set(owner: string, repo: string, terms: string[]): void {
    const k = repoKey(owner, repo);
    if (terms.length) data[k] = terms;
    else delete data[k];
    save();
  },
  /** Null when the repo has no key checks (all checks count). */
  matcher(owner: string, repo: string): ((c: CheckNames) => boolean) | null {
    const terms = this.terms(owner, repo);
    if (!terms.length) return null;
    const ms = terms.map(termMatcher);
    return (c) => forms(c).some((f) => ms.some((m) => m(f)));
  },
  clear(): void {
    data = {};
    storage.remove(KEY);
  },
};

/** Matcher for terms being edited (preview in the dialog). */
export function previewMatcher(terms: string[]): (c: CheckNames) => boolean {
  const ms = terms.map(termMatcher);
  return (c) => ms.length > 0 && forms(c).some((f) => ms.some((m) => m(f)));
}
