// Renders GitHub's pre-rendered `bodyHTML` (PR descriptions, comments).
// GitHub already sanitizes it, but it is still injected with innerHTML here, so it goes
// through a strict allowlist first: unknown tags are unwrapped, dangerous ones dropped,
// and only a few attributes survive.

/** Removed together with their contents. */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'template', 'noscript', 'link', 'meta', 'base', 'source', 'video', 'audio', 'textarea', 'select', 'button']);

const KEEP = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'kbd', 'samp',
  'strong', 'b', 'em', 'i', 'del', 's', 'ins', 'sup', 'sub', 'mark', 'small', 'span', 'div', 'a', 'img', 'input',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'details', 'summary', 'dl', 'dt', 'dd',
]);

const ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ol: ['start'],
  th: ['align'],
  td: ['align'],
  details: ['open'],
  input: ['type', 'checked'],
};

/** Classes we style; everything else is stripped so content can't borrow app styles. */
const CLASSES = /^(task-list-item|contains-task-list|user-mention|team-mention|markdown-alert(-\w+)?)$/;

function safeHref(url: string): string | null {
  try {
    const u = new URL(url, 'https://github.com/');
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function clean(el: Element): void {
  for (const child of [...el.children]) {
    const tag = child.tagName.toLowerCase();
    // Heading permalink anchors are only an icon once the svg is gone.
    if (DROP.has(tag) || (tag === 'a' && child.classList.contains('anchor'))) {
      child.remove();
      continue;
    }
    clean(child);
    if (!KEEP.has(tag) || (tag === 'input' && child.getAttribute('type') !== 'checkbox')) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    const classes = [...child.classList].filter((c) => CLASSES.test(c));
    const allowed = ATTRS[tag] ?? [];
    for (const { name } of [...child.attributes]) {
      if (!allowed.includes(name)) child.removeAttribute(name);
    }
    if (classes.length) child.className = classes.join(' ');
    if (tag === 'a') {
      const href = safeHref(child.getAttribute('href') ?? '');
      if (href) child.setAttribute('href', href);
      else child.removeAttribute('href');
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    } else if (tag === 'img') {
      const src = safeHref(child.getAttribute('src') ?? '');
      if (!src || src.startsWith('mailto:')) { child.remove(); continue; }
      child.setAttribute('src', src);
      child.setAttribute('loading', 'lazy');
      child.setAttribute('referrerpolicy', 'no-referrer');
    } else if (tag === 'input') {
      child.setAttribute('disabled', '');
    }
  }
}

/** Sanitized HTML for a GitHub `bodyHTML` field, ready to drop into a `.markdown-body`. */
export function renderGitHubHtml(html: string): string {
  // DOMParser documents are inert: nothing loads or runs while we clean.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}
