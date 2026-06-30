import MarkdownIt from 'markdown-it';

const markdownOptions = {
  html: false,
  linkify: true,
  breaks: true,
};

const md = new MarkdownIt(markdownOptions);
const mdNoTables = new MarkdownIt(markdownOptions).disable('table');
const mdLiteralInlineCode = new MarkdownIt(markdownOptions).disable('backticks');
const mdNoTablesLiteralInlineCode = new MarkdownIt(markdownOptions)
  .disable('table')
  .disable('backticks');
const mdPlainInlineCode = new MarkdownIt(markdownOptions);
const mdNoTablesPlainInlineCode = new MarkdownIt(markdownOptions).disable('table');

export type MarkdownTableMode = 'enabled' | 'disabled' | 'safe';
export type MarkdownInlineCodeMode = 'enabled' | 'disabled' | 'safe' | 'plain';

export interface RenderMarkdownOptions {
  tables?: MarkdownTableMode | boolean;
  inlineCode?: MarkdownInlineCodeMode | boolean;
}

const ALLOWED_TAGS = new Set([
  'a', 'blockquote', 'br', 'button', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead',
  'tr', 'ul',
]);
const GLOBAL_ATTRS = new Set(['class']);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  button: new Set(['aria-label', 'title', 'type']),
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

type MarkdownToken = { info?: string; content?: string };

function normalizeCodeLanguage(info: string): string {
  return String(info || '').trim().split(/\s+/)[0]?.replace(/[^\w-]/g, '').slice(0, 40) || '';
}

function renderCodeBlock(tokens: MarkdownToken[], idx: number): string {
  const token = tokens[idx] || {};
  const lang = normalizeCodeLanguage(token.info || '');
  const label = lang || 'code';
  const codeClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return [
    '<div class="markdown-code-block">',
    '<div class="markdown-code-toolbar">',
    `<span class="markdown-code-language">${escapeHtml(label)}</span>`,
    '<button type="button" class="markdown-copy-button" title="复制代码" aria-label="复制代码">复制</button>',
    '</div>',
    `<pre><code${codeClass}>${escapeHtml(token.content || '')}</code></pre>`,
    '</div>\n',
  ].join('');
}

function renderInlineCodeAsText(tokens: MarkdownToken[], idx: number): string {
  return escapeHtml(tokens[idx]?.content || '');
}

md.renderer.rules.fence = renderCodeBlock;
md.renderer.rules.code_block = renderCodeBlock;
mdNoTables.renderer.rules.fence = renderCodeBlock;
mdNoTables.renderer.rules.code_block = renderCodeBlock;
mdLiteralInlineCode.renderer.rules.fence = renderCodeBlock;
mdLiteralInlineCode.renderer.rules.code_block = renderCodeBlock;
mdNoTablesLiteralInlineCode.renderer.rules.fence = renderCodeBlock;
mdNoTablesLiteralInlineCode.renderer.rules.code_block = renderCodeBlock;
mdPlainInlineCode.renderer.rules.fence = renderCodeBlock;
mdPlainInlineCode.renderer.rules.code_block = renderCodeBlock;
mdPlainInlineCode.renderer.rules.code_inline = renderInlineCodeAsText;
mdNoTablesPlainInlineCode.renderer.rules.fence = renderCodeBlock;
mdNoTablesPlainInlineCode.renderer.rules.code_block = renderCodeBlock;
mdNoTablesPlainInlineCode.renderer.rules.code_inline = renderInlineCodeAsText;

function normalizeTableMode(value: RenderMarkdownOptions['tables']): MarkdownTableMode {
  if (value === false) return 'disabled';
  if (value === true || value === undefined) return 'enabled';
  return value;
}

function normalizeInlineCodeMode(value: RenderMarkdownOptions['inlineCode']): MarkdownInlineCodeMode {
  if (value === false) return 'disabled';
  if (value === true) return 'enabled';
  return value || 'safe';
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

interface InlineCodeSpan {
  content: string;
  end: number;
}

function backtickRunLength(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === '`') length += 1;
  return length;
}

function collectInlineCodeSpans(text: string): { spans: InlineCodeSpan[]; unbalanced: boolean } {
  const spans: InlineCodeSpan[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '`' || isEscaped(text, i)) continue;

    const markerLength = backtickRunLength(text, i);
    const contentStart = i + markerLength;
    let closed = false;

    for (let j = contentStart; j < text.length; j += 1) {
      if (text[j] !== '`' || isEscaped(text, j)) continue;
      const closeLength = backtickRunLength(text, j);
      if (closeLength !== markerLength) {
        j += closeLength - 1;
        continue;
      }
      spans.push({ content: text.slice(contentStart, j), end: j + closeLength });
      i = j + closeLength - 1;
      closed = true;
      break;
    }

    if (!closed) return { spans, unbalanced: true };
  }
  return { spans, unbalanced: false };
}

function isFenceLine(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  if (!match) return null;
  const marker = match[1][0] as '`' | '~';
  return { marker, length: match[1].length };
}

function fenceInfo(line: string): string {
  const match = line.match(/^\s*(?:`{3,}|~{3,})(.*)$/);
  return match ? match[1].trim() : '';
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

function textOutsideFences(source: string): string {
  const lines = String(source || '').split(/\r?\n/);
  const out: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (const line of lines) {
    const fenceLine = isFenceLine(line);
    if (fence) {
      if (canCloseFence(line, fence)) fence = null;
      continue;
    }
    if (fenceLine) {
      fence = fenceLine;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function hasSuspiciousInlineCode(source: string): boolean {
  const text = textOutsideFences(source);
  if (hasUnbalancedBackticks(text)) return true;
  const { spans, unbalanced } = collectInlineCodeSpans(text);
  if (unbalanced) return true;
  return spans.some((span) => {
    if (span.content.includes('\n')) return false;
    if (/^\.[A-Za-z0-9_-]+/.test(text.slice(span.end))) return true;
    return /^[\p{Script=Han}\s，。！？、：；]{1,12}$/u.test(span.content);
  });
}

function shouldRenderInlineCode(source: string, mode: MarkdownInlineCodeMode): boolean {
  if (mode === 'disabled') return false;
  if (mode === 'enabled') return true;
  if (mode === 'plain') return true;
  return !hasSuspiciousInlineCode(source);
}

function rendererFor(tableMode: MarkdownTableMode, inlineCodeMode: MarkdownInlineCodeMode, inlineCode: boolean): MarkdownIt {
  if (inlineCodeMode === 'plain') return tableMode === 'disabled' ? mdNoTablesPlainInlineCode : mdPlainInlineCode;
  if (tableMode === 'disabled') return inlineCode ? mdNoTables : mdNoTablesLiteralInlineCode;
  return inlineCode ? md : mdLiteralInlineCode;
}

function stripInlineCodeMarkersFromLine(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '`' || isEscaped(line, i)) {
      out += line[i];
      continue;
    }

    const markerLength = backtickRunLength(line, i);
    const contentStart = i + markerLength;
    let closeIndex = -1;
    for (let j = contentStart; j < line.length; j += 1) {
      if (line[j] !== '`' || isEscaped(line, j)) continue;
      const closeLength = backtickRunLength(line, j);
      if (closeLength === markerLength) {
        closeIndex = j;
        break;
      }
      j += closeLength - 1;
    }

    if (closeIndex >= 0) {
      out += line.slice(contentStart, closeIndex);
      i = closeIndex + markerLength - 1;
    } else {
      out += line.slice(contentStart);
      break;
    }
  }
  return out;
}

function stripInlineCodeMarkersOutsideFences(source: string): string {
  const lines = String(source || '').split(/\r?\n/);
  const out: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    const fenceLine = isFenceLine(line);
    if (fence) {
      out.push(line);
      if (canCloseFence(line, fence)) fence = null;
      continue;
    }
    if (fenceLine) {
      fence = fenceLine;
      out.push(line);
      continue;
    }
    out.push(stripInlineCodeMarkersFromLine(line));
  }
  return out.join('\n');
}

function transformLinesOutsideFences(source: string, transformLine: (line: string) => string): string {
  const lines = String(source || '').split(/\r?\n/);
  const out: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    const fenceLine = isFenceLine(line);
    if (fence) {
      out.push(line);
      if (canCloseFence(line, fence)) fence = null;
      continue;
    }
    if (fenceLine) {
      fence = fenceLine;
      out.push(line);
      continue;
    }
    out.push(transformLine(line));
  }
  return out.join('\n');
}

function stripStreamingMarkdownMarkersFromLine(line: string): string {
  return line
    .replace(/^(\s{0,3})#{1,6}\s+/, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/__/g, '');
}

export function streamingPlainText(text: string): string {
  return transformLinesOutsideFences(
    stripInlineCodeMarkersOutsideFences(String(text || '')),
    stripStreamingMarkdownMarkersFromLine,
  );
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function dedentCodeLines(lines: string[]): string[] {
  const trimmed = trimBlankEdges(lines);
  const indents = trimmed
    .filter((line) => line.trim())
    .map((line) => line.match(/^[ \t]*/)?.[0].length || 0);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  if (minIndent <= 0) return trimmed;
  return trimmed.map((line) => line.trim() ? line.slice(minIndent) : '');
}

function hasMarkdownTableBlock(lines: string[]): boolean {
  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = splitTableLine(lines[i]);
    const delimiter = splitTableLine(lines[i + 1]);
    if (header && header.length >= 2 && isDelimiterCells(delimiter)) return true;
  }
  return false;
}

function looksLikeMarkdownTableCode(lines: string[]): boolean {
  const dedented = dedentCodeLines(lines);
  const nonBlank = dedented.filter((line) => line.trim());
  if (nonBlank.length < 2 || !hasMarkdownTableBlock(dedented)) return false;
  const pipeLines = nonBlank.filter((line) => hasUnescapedPipe(line)).length;
  return pipeLines >= 2 && pipeLines >= Math.ceil(nonBlank.length / 2);
}

function isMarkdownishCodeLanguage(info: string): boolean {
  const lang = normalizeCodeLanguage(info).toLowerCase();
  return !lang || ['code', 'text', 'txt', 'plain', 'plaintext', 'markdown', 'md', 'mdown'].includes(lang);
}

function unwrapMarkdownTableFences(source: string): string {
  const lines = String(source || '').split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const open = isFenceLine(lines[i]);
    if (!open) {
      out.push(lines[i]);
      i += 1;
      continue;
    }

    const start = i;
    const info = fenceInfo(lines[i]);
    i += 1;
    const body: string[] = [];
    let closed = false;
    while (i < lines.length) {
      if (canCloseFence(lines[i], open)) {
        closed = true;
        break;
      }
      body.push(lines[i]);
      i += 1;
    }

    if (closed && isMarkdownishCodeLanguage(info) && looksLikeMarkdownTableCode(body)) {
      out.push(...dedentCodeLines(body));
      i += 1;
      continue;
    }

    out.push(...lines.slice(start, closed ? i + 1 : i));
    if (closed) i += 1;
  }
  return out.join('\n');
}

function unwrapIndentedMarkdownTableBlocks(source: string): string {
  const lines = String(source || '').split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!/^(?: {4,}|\t)/.test(lines[i])) {
      out.push(lines[i]);
      i += 1;
      continue;
    }

    const start = i;
    const block: string[] = [];
    while (i < lines.length && (/^(?: {4,}|\t)/.test(lines[i]) || !lines[i].trim())) {
      block.push(lines[i]);
      i += 1;
    }

    if (looksLikeMarkdownTableCode(block)) {
      out.push(...dedentCodeLines(block));
    } else {
      out.push(...lines.slice(start, i));
    }
  }
  return out.join('\n');
}

function normalizeMarkdownSourceForDisplay(source: string): string {
  return unwrapIndentedMarkdownTableBlocks(unwrapMarkdownTableFences(source));
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
  const inlineCodeMode = normalizeInlineCodeMode(options.inlineCode);
  const raw = String(text || '');
  const displaySource = normalizeMarkdownSourceForDisplay(raw);
  const plainSource = inlineCodeMode === 'plain' ? stripInlineCodeMarkersOutsideFences(displaySource) : displaySource;
  const source = mode === 'safe' ? protectUnsafeMarkdownTables(plainSource) : plainSource;
  const renderer = rendererFor(mode, inlineCodeMode, shouldRenderInlineCode(source, inlineCodeMode));
  return sanitizeHtml(renderer.render(source));
}

function fallbackCopyText(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export function setupMarkdownCodeCopy(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const global = window as Window & { __oneshellMarkdownCodeCopy?: boolean };
  if (global.__oneshellMarkdownCodeCopy) return;
  global.__oneshellMarkdownCodeCopy = true;

  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.markdown-copy-button')
      : null;
    if (!target) return;
    const block = target.closest('.markdown-code-block');
    const text = block?.querySelector('pre code')?.textContent || '';
    if (!text) return;

    const original = target.textContent || '复制';
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!fallbackCopyText(text)) throw new Error('clipboard unavailable');
      target.textContent = '已复制';
      target.classList.add('is-copied');
    } catch {
      target.textContent = '复制失败';
      target.classList.add('is-copy-error');
    }
    window.setTimeout(() => {
      target.textContent = original;
      target.classList.remove('is-copied', 'is-copy-error');
    }, 1500);
  });
}
