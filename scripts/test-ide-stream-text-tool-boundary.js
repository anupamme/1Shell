'use strict';

// Guard: streaming text + mid-stream tool-start must not re-speak assistant text
// after tool cards (architecture must not duplicate AI output on the timeline).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../src/config/env');

const ideService = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ide', 'ide.service.js'), 'utf8');
const useIdeChat = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'composables', 'useIdeChat.ts'), 'utf8');

// Backend: once text-delta already streamed, do not always re-emit ide:text
assert.ok(
  ideService.includes('已通过 text-delta 流过的原文不要再 ide:text 重说一遍'),
  'ide.service must avoid re-speaking streamed assistant text',
);
assert.ok(
  ideService.includes("if (!data._emittedTextDelta)"),
  'non-streamed path must still emit text',
);
assert.ok(
  ideService.includes('} else if (exactExpansion.expanded) {'),
  'exact expansion path must still re-emit for rewrite',
);

// Frontend: ide:text with prior deltas only replaces an open bubble
assert.ok(
  useIdeChat.includes('流式阶段已画过：只定稿仍打开的气泡，不在工具卡后再代说一遍'),
  'useIdeChat must refuse to open a second assistant bubble after tool-start sealed the first',
);
assert.ok(
  useIdeChat.includes('if (currentAssistant) {\n            replaceAssistantText(msg.text);\n          }'),
  'ide:text replace path must require an open currentAssistant',
);
assert.ok(
  useIdeChat.includes('patchLastSealedAssistantText'),
  'exact text-replace after seal must patch the sealed bubble instead of minting a new one',
);
assert.ok(
  useIdeChat.includes('只封存气泡，不清 currentTextHadDelta'),
  'tool-start seal must keep currentTextHadDelta so final ide:text does not append',
);

// Negative: the old unconditional final ide:text after both stream branches must stay gone
{
  const marker = 'const visibleText = exactExpansion.text;';
  const idx = ideService.indexOf(marker);
  assert.ok(idx >= 0, 'visibleText finalization block must exist');
  const slice = ideService.slice(idx, idx + 1600);
  // Old shape: emit delta / replace, then always emit ide:text at the same indent as the if
  assert.ok(
    !slice.includes("emitToSession(session, socket, 'ide:text', { sessionId, runId, text: visibleText, exactExpanded: exactExpansion.expanded, exactRefs: exactExpansion.refs });\n        recordTraceEvent"),
    'must not always emit ide:text before recordTraceEvent after every visible text path',
  );
}

console.log('ide stream text/tool boundary checks passed');
