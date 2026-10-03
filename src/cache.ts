// Local cache of the org list and each owner's repo list, so pickers open instantly.
// Refreshed only by an explicit "Sync" (or when nothing is cached yet).
import { storage } from './api';
import type { Repo, Viewer } from './queries';

const KEY = 'gh_pr_cache_v3';
// v1 held full repo lists; v2 could hold an empty org list from fine-grained tokens.
storage.remove('gh_pr_cache_v1');
storage.remove('gh_pr_cache_v2');

interface Entry<T> {
  data: T;
  at: number;
}

interface CacheShape {
  viewer?: Entry<Viewer>;
  repos: Record<string, Entry<Repo[]>>;
}

function read(): CacheShape {
  try {
    const v = JSON.parse(storage.get(KEY) ?? '{}');
    return { viewer: v.viewer, repos: v.repos && typeof v.repos === 'object' ? v.repos : {} };
  } catch {
    return { repos: {} };
  }
}

let data = read();
const save = () => storage.set(KEY, JSON.stringify(data));
const key = (owner: string) => owner.toLowerCase();

export const cache = {
  viewer(): Entry<Viewer> | undefined {
    return data.viewer;
  },
  setViewer(viewer: Viewer): void {
    data.viewer = { data: viewer, at: Date.now() };
    save();
  },
  repos(owner: string): Entry<Repo[]> | undefined {
    return data.repos[key(owner)];
  },
  setRepos(owner: string, repos: Repo[]): void {
    data.repos[key(owner)] = { data: repos, at: Date.now() };
    save();
  },
  clear(): void {
    data = { repos: {} };
    storage.remove(KEY);
  },
};
