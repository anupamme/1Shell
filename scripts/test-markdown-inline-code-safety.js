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
const { streamingPlainText } = moduleContext.exports;
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

const partialStreamHtml = renderMarkdown('- CPU 使用率：约 `1.55%', { tables: 'safe', inlineCode: 'plain' });
assert.ok(
  partialStreamHtml.includes('CPU 使用率：约 1.55%'),
  'plain inline-code mode should hide an opening inline marker while streaming partial text',
);
assert.ok(
  !partialStreamHtml.includes('`'),
  'streaming partial inline markers must not be visible',
);
const partialStreamText = streamingPlainText([
  '## 主机信息',
  '- 主机名：`demo-host-lax-1',
  '- CPU 使用率：约 **1.64',
  '- Load：`0.19`',
].join('\n'));
assert.strictEqual(
  partialStreamText,
  [
    '主机信息',
    '- 主机名：demo-host-lax-1',
    '- CPU 使用率：约 1.64',
    '- Load：0.19',
  ].join('\n'),
  'streaming plain text should remove partial inline/bold markers before markdown parsing',
);

const fencedHtml = renderMarkdown([
  '执行命令：',
  '```bash',
  'printf `date`',
  '```',
].join('\n'), { tables: 'safe', inlineCode: 'plain' });
assert.ok(
  fencedHtml.includes('printf `date`'),
  'plain inline-code mode must not strip backticks inside fenced code blocks',
);

const reportHtml = renderMarkdown([
  '## 巡检报告',
  '**硬件**',
  '',
  '```markdown',
  '| 项目 | 详情 |',
  '| --- | --- |',
  '| CPU | `2 核` |',
  '| 内存 | 11 GB |',
  '```',
].join('\n'), { tables: 'safe', inlineCode: 'plain' });
assert.ok(
  reportHtml.includes('<h2>巡检报告</h2>') && reportHtml.includes('<strong>硬件</strong>'),
  'plain inline-code mode should preserve normal final markdown formatting',
);
assert.ok(
  reportHtml.includes('<table>') && reportHtml.includes('<td>2 核</td>') && !reportHtml.includes('markdown-code-block'),
  'markdown tables wrapped in markdown code fences should render as real tables',
);

const indentedTableHtml = renderMarkdown([
  '    | 项目 | 详情 |',
  '    | --- | --- |',
  '    | 端口 | `22` |',
].join('\n'), { tables: 'safe', inlineCode: 'plain' });
assert.ok(
  indentedTableHtml.includes('<table>') && indentedTableHtml.includes('<td>22</td>'),
  'indented markdown table blocks should render as real tables',
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
