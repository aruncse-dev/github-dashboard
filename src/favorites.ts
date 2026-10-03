// Favourite orgs and repos, kept per browser in localStorage (like the token).
import { storage } from './api';

const KEY = 'gh_pr_favs';

interface Favs {
  orgs: string[];
  /** "owner/name" */
  repos: string[];
}

function read(): Favs {
  try {
    const v = JSON.parse(storage.get(KEY) ?? '{}');
    return { orgs: Array.isArray(v.orgs) ? v.orgs : [], repos: Array.isArray(v.repos) ? v.repos : [] };
  } catch {
    return { orgs: [], repos: [] };
  }
}

let favs = read();
const save = () => storage.set(KEY, JSON.stringify(favs));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const favorites = {
  orgs(): string[] {
    return [...favs.orgs];
  },
  /** Favourite repo names (without owner) for one owner. */
  repos(owner: string): string[] {
    return favs.repos
      .map((r) => r.split('/'))
      .filter(([o]) => same(o, owner))
      .map(([, name]) => name);
  },
  isOrg(owner: string): boolean {
    return favs.orgs.some((o) => same(o, owner));
  },
  isRepo(owner: string, name: string): boolean {
    return favs.repos.some((r) => same(r, `${owner}/${name}`));
  },
  /** Returns the new favourite state. */
  toggleOrg(owner: string): boolean {
    const on = !this.isOrg(owner);
    favs.orgs = on ? [...favs.orgs, owner] : favs.orgs.filter((o) => !same(o, owner));
    save();
    return on;
  },
  toggleRepo(owner: string, name: string): boolean {
    const full = `${owner}/${name}`;
    const on = !this.isRepo(owner, name);
    favs.repos = on ? [...favs.repos, full] : favs.repos.filter((r) => !same(r, full));
    save();
    return on;
  },
  addOrg(owner: string): void {
    if (!this.isOrg(owner)) this.toggleOrg(owner);
  },
  clear(): void {
    favs = { orgs: [], repos: [] };
    storage.remove(KEY);
  },
};
