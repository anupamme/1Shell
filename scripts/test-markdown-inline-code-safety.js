'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('../frontend/node_modules/typescript');

const sourcePath = path.join(__dirname, '..', 'frontend', 'src', 'utils', 'markdown.ts');
const source = `${fs.readFileSync(sourcePath, 'utf8')}

export const __markdownInlineCodeTest = { hasSuspiciousInlineCode, shouldRenderInlineCode };
`;

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const moduleContext = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleContext,
  exports: moduleContext.exports,
  DOMParser: class {
    parseFromString(html) {
      const innerHTML = String(html).replace(/^<div>/, '').replace(/<\/div>$/, '');
      return {
        body: { firstElementChild: { innerHTML } },
        createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
      };
    }
  },
  NodeFilter: { SHOW_ELEMENT: 1 },
  require: (id) => (id === 'markdown-it' ? { default: require('../frontend/node_modules/markdown-it') } : require(id)),
}, { filename: sourcePath });

const { renderMarkdown } = moduleContext.exports;
const { hasSuspiciousInlineCode, shouldRenderInlineCode } = moduleContext.exports.__markdownInlineCodeTest;

const systemReport = [
  '- 磁盘：',
  '  - 根分区 `/`：`77G`',
  '- `openresty`：监听 `80`、`443`',
  '- 防火墙状态：`inactive`',
].join('\n');

assert.strictEqual(
  hasSuspiciousInlineCode(systemReport),
  false,
  'adjacent inline-code spans separated by Chinese punctuation must not disable inline code rendering',
);
assert.strictEqual(
  shouldRenderInlineCode(systemReport, 'safe'),
  true,
  'safe markdown mode should still render valid inline code in system reports',
);
const plainHtml = renderMarkdown(systemReport, { tables: 'safe', inlineCode: 'plain' });
assert.ok(
  plainHtml.includes('根分区 /：77G'),
  'plain inline-code mode should keep inline code text without markdown markers',
);
assert.ok(
  !plainHtml.includes('`') && !plainHtml.includes('<code>'),
  'plain inline-code mode should not expose backticks or create inline code tags',
);

assert.strictEqual(
  hasSuspiciousInlineCode('这个中文标点不应成为代码：`：`'),
  true,
  'actual Chinese punctuation-only code spans should remain suspicious',
);
assert.strictEqual(
  hasSuspiciousInlineCode('对象访问 `config`.path'),
  true,
  'property access split by inline code should remain suspicious',
);
assert.strictEqual(
  hasSuspiciousInlineCode('未闭合的 `inline code'),
  true,
  'unbalanced inline code markers should remain suspicious',
);

console.log('markdown inline-code safety checks passed');
