import MarkdownIt from 'markdown-it';

const markdownOptions = {
  html: false,
  linkify: true,
  breaks: true,
};

const md = new MarkdownIt(markdownOptions);
const mdNoTables = new MarkdownIt(markdownOptions).disable('table');

export type MarkdownTableMode = 'enabled' | 'disabled' | 'safe';

export interface RenderMarkdownOptions {
  tables?: MarkdownTableMode | boolean;
}

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

function normalizeTableMode(value: RenderMarkdownOptions['tables']): MarkdownTableMode {
  if (value === false) return 'disabled';
  if (value === true || value === undefined) return 'enabled';
  return value;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashCount += 1;
  return slashCount % 2 === 1;
}

function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|' && !isEscaped(line, i)) return true;
  }
  return false;
}

function stripOuterPipe(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && /\s/.test(line[start])) start += 1;
  while (end > start && /\s/.test(line[end - 1])) end -= 1;
  if (line[start] === '|' && !isEscaped(line, start)) start += 1;
  if (end > start && line[end - 1] === '|' && !isEscaped(line, end - 1)) end -= 1;
  return line.slice(start, end);
}

function splitTableLine(line: string): string[] | null {
  if (!hasUnescapedPipe(line)) return null;
  const body = stripOuterPipe(line);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '|' && !isEscaped(body, i)) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.some(Boolean) ? cells : null;
}

function isDelimiterCells(cells: string[] | null): boolean {
  return Boolean(cells?.length) && cells!.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function hasUnbalancedBackticks(text: string): boolean {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '`' && !isEscaped(text, i)) count += 1;
  }
  return count % 2 === 1;
}

function isFenceLine(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  if (!match) return null;
  const marker = match[1][0] as '`' | '~';
  return { marker, length: match[1].length };
}

function canCloseFence(line: string, fence: { marker: '`' | '~'; length: number }): boolean {
  const pattern = fence.marker === '`' ? /^(\s*)`{3,}/ : /^(\s*)~{3,}/;
  const match = line.match(pattern);
  return Boolean(match && match[0].trim().length >= fence.length);
}

function fenceFor(text: string): string {
  return text.includes('```') ? '~~~' : '```';
}

function fencePlainTextBlock(lines: string[]): string[] {
  const block = lines.join('\n');
  const fence = fenceFor(block);
  return [fence, block, fence];
}

function isUnsafeTableBlock(lines: string[]): boolean {
  if (lines.length < 2) return true;
  const header = splitTableLine(lines[0]);
  const delimiter = splitTableLine(lines[1]);
  if (!header || !isDelimiterCells(delimiter)) return true;
  const columnCount = header.length;
  if (columnCount < 2 || delimiter!.length !== columnCount) return true;
  if (hasUnbalancedBackticks(lines.join('\n'))) return true;
  for (const line of lines.slice(2)) {
    const cells = splitTableLine(line);
    if (!cells || cells.length !== columnCount) return true;
  }
  return false;
}

function protectUnsafeMarkdownTables(source: string): string {
  const lines = String(source || '').split(/\r?\n/);
  const out: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const fenceLine = isFenceLine(line);
    if (fence) {
      out.push(line);
      if (canCloseFence(line, fence)) fence = null;
      i += 1;
      continue;
    }
    if (fenceLine) {
      fence = fenceLine;
      out.push(line);
      i += 1;
      continue;
    }

    const header = splitTableLine(line);
    const delimiter = i + 1 < lines.length ? splitTableLine(lines[i + 1]) : null;
    if (!header || !isDelimiterCells(delimiter)) {
      out.push(line);
      i += 1;
      continue;
    }

    const block = [line, lines[i + 1]];
    i += 2;
    while (i < lines.length && hasUnescapedPipe(lines[i]) && lines[i].trim()) {
      block.push(lines[i]);
      i += 1;
    }
    out.push(...(isUnsafeTableBlock(block) ? fencePlainTextBlock(block) : block));
  }

  return out.join('\n');
}

export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const mode = normalizeTableMode(options.tables);
  const source = mode === 'safe' ? protectUnsafeMarkdownTables(String(text || '')) : String(text || '');
  const renderer = mode === 'disabled' ? mdNoTables : md;
  return sanitizeHtml(renderer.render(source));
}
