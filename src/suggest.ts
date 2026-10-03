// Autocomplete for the PR search box: GitHub qualifiers, their values, and recent searches.
import { storage } from './api';
import { esc, icon } from './ui';

export interface SuggestContext {
  me: string;
  authors: string[];
  branches: string[];
  /** Resolves the current repo's labels (cached by the caller). */
  labels: () => Promise<string[]>;
}

interface Suggestion {
  /** Text that replaces the token being typed (or the whole input for recent searches). */
  insert: string;
  label: string;
  desc?: string;
  /** Keep the panel open to pick a value (e.g. "label:"). */
  more?: boolean;
  recent?: boolean;
}

const RECENT_KEY = 'gh_pr_recent_searches';
const MAX_RECENT = 6;

const QUALIFIERS: Suggestion[] = [
  { insert: 'review-requested:@me', label: 'review-requested:@me', desc: 'Waiting for your review' },
  { insert: 'author:@me', label: 'author:@me', desc: 'Opened by you' },
  { insert: 'author:', label: 'author:', desc: 'Opened by a user', more: true },
  { insert: 'label:', label: 'label:', desc: 'Has a label', more: true },
  { insert: 'review:', label: 'review:', desc: 'Approved, changes requested, required…', more: true },
  { insert: 'status:', label: 'status:', desc: 'CI checks passed, failing or pending', more: true },
  { insert: 'head:', label: 'head:', desc: 'From a branch', more: true },
  { insert: 'base:', label: 'base:', desc: 'Into a branch', more: true },
  { insert: 'draft:false', label: 'draft:false', desc: 'Hide drafts' },
  { insert: 'is:draft', label: 'is:draft', desc: 'Only drafts' },
  { insert: 'reviewed-by:@me', label: 'reviewed-by:@me', desc: 'You already reviewed' },
  { insert: 'assignee:@me', label: 'assignee:@me', desc: 'Assigned to you' },
  { insert: 'mentions:@me', label: 'mentions:@me', desc: 'Mentions you' },
  { insert: 'created:', label: 'created:', desc: 'Opened within a time range', more: true },
  { insert: 'updated:', label: 'updated:', desc: 'Updated within a time range', more: true },
  { insert: 'no:label', label: 'no:label', desc: 'Without labels' },
  { insert: 'comments:>0', label: 'comments:>0', desc: 'Has comments' },
];

const FIXED_VALUES: Record<string, Array<[string, string]>> = {
  review: [['approved', 'Approved'], ['changes_requested', 'Changes requested'], ['required', 'Review required'], ['none', 'No reviews yet']],
  status: [['success', 'All checks passed'], ['failure', 'Some checks failed'], ['pending', 'Checks running']],
  is: [['draft', 'Draft pull requests']],
};

function dateDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 864e5);
  return d.toISOString().slice(0, 10);
}

function dateValues(): Array<[string, string]> {
  return [
    [`>=${dateDaysAgo(1)}`, 'Last 24 hours'],
    [`>=${dateDaysAgo(7)}`, 'Last 7 days'],
    [`>=${dateDaysAgo(30)}`, 'Last 30 days'],
    [`<${dateDaysAgo(30)}`, 'Older than 30 days'],
  ];
}

export function recentSearches(): string[] {
  try {
    const v = JSON.parse(storage.get(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): void {
  const text = q.trim();
  if (!text) return;
  const list = [text, ...recentSearches().filter((x) => x !== text)].slice(0, MAX_RECENT);
  storage.set(RECENT_KEY, JSON.stringify(list));
}

/** The whitespace-delimited token ending at the caret. */
function tokenAt(input: HTMLInputElement): { start: number; end: number; text: string } {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const start = before.search(/\S*$/);
  const afterMatch = input.value.slice(caret).match(/^\S*/);
  const end = caret + (afterMatch ? afterMatch[0].length : 0);
  return { start, end, text: input.value.slice(start, end) };
}

/** True while the user is mid-way through a qualifier such as "label:" with no value yet. */
export function hasIncompleteQualifier(value: string): boolean {
  return /(^|\s)-?[a-z-]+:$/i.test(value.trimEnd()) && !/\s$/.test(value);
}

export function initSuggest(
  input: HTMLInputElement,
  panel: HTMLElement,
  getContext: () => SuggestContext,
  onSubmit: () => void,
): void {
  let items: Suggestion[] = [];
  let active = -1;
  let labelCache: string[] | null = null;
  let labelsLoading = false;
  let renderSeq = 0;

  const close = () => {
    panel.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const open = () => {
    panel.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  };

  async function compute(): Promise<{ list: Suggestion[]; heading: string; note?: string }> {
    const ctx = getContext();
    const token = tokenAt(input).text;
    const neg = token.startsWith('-') ? '-' : '';
    const colon = token.indexOf(':');

    // Value suggestions for "key:partial".
    if (colon > 0) {
      const key = token.slice(neg.length, colon).toLowerCase();
      const partial = token.slice(colon + 1).toLowerCase();
      let values: Array<[string, string]> = [];
      let note: string | undefined;
      if (['author', 'reviewed-by', 'assignee', 'mentions', 'review-requested', 'commenter', 'involves'].includes(key)) {
        values = [['@me', `You (${ctx.me})`], ...ctx.authors.filter((a) => a !== ctx.me).map((a): [string, string] => [a, ''])];
      } else if (key === 'label') {
        if (!labelCache && !labelsLoading) {
          labelsLoading = true;
          ctx.labels()
            .then((l) => { labelCache = l; })
            .catch(() => { labelCache = []; })
            .finally(() => { labelsLoading = false; if (!panel.classList.contains('hidden')) void render(); });
        }
        values = (labelCache ?? []).map((l): [string, string] => [/\s/.test(l) ? `"${l}"` : l, '']);
        if (labelsLoading) note = 'Loading labels…';
        else if (labelCache && !labelCache.length) note = 'This repository has no labels';
      } else if (key === 'head' || key === 'base') {
        values = ctx.branches.map((b): [string, string] => [b, '']);
      } else if (key === 'created' || key === 'updated' || key === 'merged' || key === 'closed') {
        values = dateValues();
      } else if (FIXED_VALUES[key]) {
        values = FIXED_VALUES[key];
      }
      const list = values
        .filter(([v]) => v.toLowerCase().replace(/^"/, '').startsWith(partial.replace(/^"/, '')) || (partial && v.toLowerCase().includes(partial)))
        .slice(0, 12)
        .map(([v, desc]) => ({ insert: `${neg}${key}:${v}`, label: `${neg}${key}:${v}`, desc }));
      return { list, heading: `${key}:`, note };
    }

    // Qualifier suggestions (plus recent searches when the box is empty).
    const t = token.toLowerCase().replace(/^-/, '');
    const quals = QUALIFIERS.filter((s) => !t || s.label.startsWith(t) || (t.length > 1 && (s.desc ?? '').toLowerCase().includes(t)))
      .map((s) => ({ ...s, insert: neg + s.insert, label: neg + s.label }));
    const recents = !input.value.trim()
      ? recentSearches().map((r) => ({ insert: r, label: r, recent: true }))
      : [];
    return { list: [...recents, ...quals].slice(0, 12), heading: recents.length ? 'Recent searches & filters' : 'Filters' };
  }

  async function render(): Promise<void> {
    const seq = ++renderSeq;
    const { list, heading, note } = await compute();
    if (seq !== renderSeq) return;
    items = list;
    if (active >= items.length) active = items.length - 1;
    if (!items.length && !note) return close();
    panel.innerHTML =
      `<div class="suggest-head">${esc(heading)}</div>` +
      items.map((s, i) => `
        <div class="suggest-item${i === active ? ' active' : ''}" role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === active}">
          ${icon(s.recent ? 'sync' : 'search', 'c-muted')}
          <code>${esc(s.label)}</code>
          ${s.desc ? `<span class="desc">${esc(s.desc)}</span>` : ''}
        </div>`).join('') +
      (note ? `<div class="suggest-note">${esc(note)}</div>` : '');
    input.setAttribute('aria-activedescendant', active >= 0 ? `sg-${active}` : '');
    open();
  }

  function apply(s: Suggestion): void {
    if (s.recent) {
      input.value = s.insert;
    } else {
      const { start, end } = tokenAt(input);
      const before = input.value.slice(0, start);
      const after = input.value.slice(end).replace(/^\s*/, '');
      const sep = s.more ? '' : ' ';
      input.value = `${before}${s.insert}${sep}${after}`;
      const caret = before.length + s.insert.length + sep.length;
      input.setSelectionRange(caret, caret);
    }
    active = -1;
    if (s.more) {
      input.focus();
      void render();
    } else {
      close();
      onSubmit();
    }
  }

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', panel.id);
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('focus', () => void render());
  input.addEventListener('input', () => { active = -1; void render(); });
  input.addEventListener('click', () => void render());
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    const isOpen = !panel.classList.contains('hidden');
    if (e.key === 'ArrowDown' && isOpen) {
      e.preventDefault();
      active = Math.min(items.length - 1, active + 1);
      void render();
    } else if (e.key === 'ArrowUp' && isOpen) {
      e.preventDefault();
      active = Math.max(-1, active - 1);
      void render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && active >= 0 && items[active]) apply(items[active]);
      else {
        close();
        onSubmit();
        input.blur();
      }
    } else if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      close();
    }
  });
  // Keep focus in the input while tapping a suggestion.
  panel.addEventListener('pointerdown', (e) => e.preventDefault());
  panel.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (el) apply(items[+el.dataset.i!]);
  });

  /** Labels belong to a repo: drop them when the repo changes. */
  input.addEventListener('suggest:reset', () => { labelCache = null; });
}
