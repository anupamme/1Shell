'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../src/config/env');

const source = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ide', 'ide.service.js'), 'utf8');

assert(source.includes('EMPTY_MODEL_RESPONSE_RETRY_LIMIT'), 'IDE loop must cap empty model response retries');
assert(source.includes('createEmptyModelResponseObservation'), 'IDE loop must inject a continuation observation after an empty model response');
assert(source.includes('isEmptyModelResult(lastResult)'), 'IDE loop must distinguish empty responses from visible final answers');
assert(source.includes('empty_model_response'), 'IDE loop must trace empty model responses');
assert(source.includes('Cannot continue IDE agent run: provider returned empty assistant responses repeatedly.'), 'repeated empty responses must surface as an error');
assert(!source.includes('if (toolCalls.length === 0) break; // model produced a final answer (end_turn)'), 'empty no-tool responses must not be treated as final answers');
assert(source.includes('TASK_AUTHORING_PACKAGING_RETRY_LIMIT'), '/task mode must cap packaging continuation retries');
assert(source.includes('shouldContinueTaskAuthoringPackaging'), '/task mode must prevent finalizing after verified practice before saving a task');
assert(source.includes('RUNTIME_TASK_PACKAGING_REQUIRED'), '/task mode must inject a packaging-required observation');
assert(source.includes('task_packaging_required'), '/task packaging guard must be traced');
assert(source.includes('Cannot complete /task authoring: the workflow was practiced and verified, but no AI task was saved.'), '/task mode must error visibly if packaging is repeatedly skipped');

console.log('ide empty response guard checks passed');
