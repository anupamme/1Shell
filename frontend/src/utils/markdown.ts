import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const ALLOWED_TAGS = new Set([
  'a', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead',
  'tr', 'ul',
]);
const GLOBAL_ATTRS = new Set(['class']);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  code: new Set(['class']),
  pre: new Set(['class']),
};
const SAFE_URL_RE = /^(https?:|mailto:|tel:|#|\/)/i;

function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const nodes: Element[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Element);

  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }

    const allowedAttrs = TAG_ATTRS[tag] || new Set<string>();
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!GLOBAL_ATTRS.has(name) && !allowedAttrs.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (tag === 'a' && name === 'href' && !SAFE_URL_RE.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }

    if (tag === 'a') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  return root.innerHTML;
}

export function escapeHtml(text: string): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export function renderMarkdown(text: string): string {
  return sanitizeHtml(md.render(String(text || '')));
}
