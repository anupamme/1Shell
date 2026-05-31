'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../src/config/env');
const { createIdeTools } = require('../src/ide/ide.tools');
const {
  AuthoringSessionManager,
  createAuthoringPromptBlock,
  detectAuthoringIntent,
  gateAuthoringTool,
  recordAuthoringArtifact,
  recordAuthoringOptions,
  recordAuthoringQuestion,
  recordAuthoringReply,
  recordCommitApprovalRequest,
  requiredAuthoringToolMessage,
  requiredAuthoringToolsForStage,
} = require('../src/authoring/session-manager');

async function main() {
  const ideServiceSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ide', 'ide.service.js'), 'utf8');
  const sessionManagerSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'authoring', 'session-manager.js'), 'utf8');
  const oneShellPromptSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ai', 'oneshell-ai-prompt.js'), 'utf8');
  const studioRunnerSource = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'composables', 'useStudioRunner.ts'), 'utf8');
  const pauseSetMatch = ideServiceSource.match(/const AUTHORING_PAUSE_AFTER_TOOLS = new Set\(\[([\s\S]*?)\]\);/);
  assert(pauseSetMatch, '必须能找到 AUTHORING_PAUSE_AFTER_TOOLS');
  assert(!pauseSetMatch[1].includes('create_program_draft'), 'create_program_draft 后不能无条件暂停，否则 validation 失败无法继续增量修复');
  assert(!pauseSetMatch[1].includes('create_skill_draft'), 'create_skill_draft 后不能无条件暂停，draft 校验失败应继续修复');
  assert(ideServiceSource.includes("'update_authoring_draft'"), 'update_authoring_draft 必须作为无需审批的 authoring artifact 工具放行');
  assert(ideServiceSource.includes('PROVIDER_TRANSIENT_RETRY'), 'Provider 504/502 等临时错误必须注入续跑指令，而不是直接结束');
  assert(ideServiceSource.includes('AUTHORING_REPAIR_REQUIRED'), 'invalid draft tool_result 必须附加强制增量修复指令');
  assert(ideServiceSource.includes('compactToolResultForModel'), 'Authoring tool_result 必须裁剪后再回灌模型，避免上下文膨胀导致 504');
  assert(ideServiceSource.includes('PARALLEL_SAFE_TOOLS'), '只读工具必须有并发调度白名单');
  assert(ideServiceSource.includes('Promise.all(toolCalls.map'), '同一轮多个只读工具必须并发执行');
  assert(sessionManagerSource.includes('AI 工作流 run 粒度按任务规模决定'), 'Program 创建提示必须明确 AI run 粒度按任务规模决定');
  assert(oneShellPromptSource.includes('UI 阶段卡片只是抽象进度，不是 AI 调用边界'), '1Shell AI prompt 必须禁止把 UI 阶段等同于 AI 调用边界');
  assert(studioRunnerSource.includes('programAuthoringStageDefs'), 'Studio 顶部步骤条必须有 Program 专用流程定义');
  assert(studioRunnerSource.includes("label: '类型判断'") && studioRunnerSource.includes("label: 'Program 定义'"), 'Program 顶部步骤条必须显示新的类型判断/Program 定义流程');

  const certRequest = '创建一个程序，其功能是申请证书，完整链路是先扫描已反向代理后的端口，然后给它们安装证书。前端需要端口、域名、Cloudflare API key、是否开启 https。';

  const detected = detectAuthoringIntent(certRequest, {}, 'studio');
  assert.strictEqual(detected.shouldStart, true, '证书 Program 请求必须触发 Authoring Flow');
  assert.strictEqual(detected.intent, 'create_program', '证书 Program 请求必须识别为 create_program');
  assert.strictEqual(detected.complexity, 'complex', '证书 Program 请求必须识别为 complex');
  assert.strictEqual(detected.risk, 'high', '证书 Program 请求必须识别为 high risk');
  assert.strictEqual(detected.programMode, 'ai_workflow', '证书 Program 请求必须识别为 AI 工作流 Program');

  const studioWordingRequest = '创作一个程序，功能是证书申请，在前端中填入cloudflare里面的域名，cloudflare apikey，填入对应的端口，选择对应的主机，然后开始申请证书，申请失败时唤起ai来进行处理';
  const studioWordingDetected = detectAuthoringIntent(studioWordingRequest, {}, 'studio');
  assert.strictEqual(studioWordingDetected.shouldStart, true, '创作一个程序必须触发 Authoring Flow');
  assert.strictEqual(studioWordingDetected.intent, 'create_program', '创作一个程序必须识别为 create_program');
  const studioWordingSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-studio-wording', message: studioWordingRequest, context: {}, entry: 'studio' });
  assert(studioWordingSession, '创作台自然用语必须创建 Authoring Session');

  const manager = new AuthoringSessionManager();
  const session = manager.ensureForMessage({ ideSessionId: 'sess-test', message: certRequest, context: {}, entry: 'studio' });
  assert(session, '必须创建 Authoring Session');
  assert.strictEqual(session.stage, 'discovery', '新 Authoring Session 必须从 discovery 开始');
  assert.strictEqual(session.facts.programMode, 'ai_workflow', 'Program Session 必须记录 AI 工作流类型');

  const readAllowed = gateAuthoringTool(session, 'list_hosts');
  assert.strictEqual(readAllowed, null, 'discovery 阶段必须允许 list_hosts');

  for (const toolName of ['write_file', 'reload_registry', 'trigger_program', 'execute_command']) {
    const blocked = gateAuthoringTool(session, toolName);
    assert(blocked?.is_error, `${toolName} 必须在 discovery 阶段被阻断`);
    assert(blocked.content.includes(`[BLOCKED] 当前 Authoring Session 处于 discovery 阶段，不能调用 ${toolName}。`), `${toolName} 阻断文案必须清晰`);
  }

  const questionAllowed = gateAuthoringTool(session, 'ask_authoring_question');
  assert.strictEqual(questionAllowed, null, 'discovery 阶段必须允许 ask_authoring_question');
  const question = recordAuthoringQuestion(session, {
    question: '目标反代服务是什么？',
    kind: 'single_choice',
    options: [
      { id: 'nginx', label: 'nginx' },
      { id: 'caddy', label: 'caddy' },
    ],
  });
  assert(question, '必须能创建 question interaction');
  assert.strictEqual(session.interactions.length, 1, 'question 必须写入 session interactions');
  const reply = recordAuthoringReply(session, { interactionId: question.id, value: 'nginx', text: '目标主机上已有反代服务' });
  assert(reply, '必须能记录 Program discovery 问题回复');
  assert.strictEqual(session.stage, 'discovery', 'Program 问题回复后必须仍停留在 discovery，不进入 options');

  assert.strictEqual(gateAuthoringTool(session, 'create_program_draft'), null, 'Program discovery 阶段必须允许直接 create_program_draft');
  assert.deepStrictEqual(requiredAuthoringToolsForStage(session), [], 'Program discovery 阶段不应强制 create_program_spec');
  assert.strictEqual(requiredAuthoringToolMessage(session), '', 'Program discovery 阶段不应提示必须创建 Spec/Plan');

  for (const toolName of ['propose_options', 'create_program_spec', 'create_authoring_plan']) {
    const blocked = gateAuthoringTool(session, toolName);
    assert(blocked?.is_error, `Program 创建必须阻断旧工具 ${toolName}`);
    assert(blocked.content.includes(`不能调用 ${toolName}`), `${toolName} 阻断文案必须清晰`);
  }

  const options = recordAuthoringOptions(session, {
    title: '请选择自动化边界',
    description: '证书申请涉及凭据和服务 reload。',
    options: [
      { id: 'safe', label: '只申请证书', summary: '不改反代配置', risk: 'low' },
      { id: 'auto', label: '全自动', summary: '写配置并 reload', risk: 'high' },
    ],
  });
  assert.strictEqual(options, null, 'Program 创建不能创建旧 options interaction');
  assert.strictEqual(session.stage, 'discovery', 'Program 创建不能被旧 options/spec/plan 链路推进');

  const simpleDetected = detectAuthoringIntent('创建一个程序，用来开关 my-app 服务。', {}, 'studio');
  assert.strictEqual(simpleDetected.shouldStart, true, '简单 Program 请求必须触发 Authoring Flow');
  assert.strictEqual(simpleDetected.intent, 'create_program', '简单 Program 请求必须识别为 create_program');
  assert.strictEqual(simpleDetected.programMode, 'code_execution', '简单 Program 请求必须识别为代码执行型 Program');

  const validProgramYaml = `name: 反代端口证书申请
description: 测试 Program 草案
enabled: false
hosts: all
triggers:
  - id: manual_run
    type: manual
    action: issue_certificate
actions:
  issue_certificate:
    on_fail: stop
    steps:
      - id: check_target
        label: 检查目标
        run: echo ok
        verify:
          exit_code: 0
          stdout_contains: ok
      - id: render_result
        type: render
        format: message
        title: 结果
        content_from: check_target
`;

  function programDraftFiles(programId, filePath, content = validProgramYaml) {
    const root = `data/programs/${programId}`;
    return [
      { path: filePath, content },
      { path: `${root}/ui/DESIGN.md`, content: '# Test UI\n\n用于 authoring session 测试的最小 Program UI。\n' },
      { path: `${root}/ui/manifest.json`, content: JSON.stringify({ schemaVersion: 1, runtime: 'react-jsx', entry: 'App.jsx', styles: ['style.css'], design: 'DESIGN.md', permissions: { actions: ['issue_certificate'], readRuns: true, readResults: true, readEvents: true } }, null, 2) },
      { path: `${root}/ui/App.jsx`, content: "const { React, ReactDOM, $oneShell } = window;\nfunction App() {\n  const snapshot = $oneShell.useProgram();\n  const hosts = Array.isArray(snapshot.hosts) ? snapshot.hosts : [];\n  const [selectedHostId, setSelectedHostId] = React.useState(hosts[0] ? hosts[0].id : '');\n  return <div>{hosts.map((host) => <button key={host.id} onClick={() => setSelectedHostId(host.id)}>{host.label || host.name || host.id}</button>)}<button onClick={() => $oneShell.runAction('issue_certificate', { hostId: selectedHostId, inputs: {} })}>{snapshot.program ? snapshot.program.name : 'run'}</button></div>;\n}\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n" },
      { path: `${root}/ui/style.css`, content: 'button { font: inherit; }\n' },
    ];
  }

  const followupManager = new AuthoringSessionManager();
  const completedProgramSession = followupManager.ensureForMessage({ ideSessionId: 'sess-followup-program', message: '创建一个程序 reverse-proxy-https-assistant', context: {}, entry: 'studio' });
  const completedProgramDraft = recordAuthoringArtifact(completedProgramSession, {
    type: 'program_draft',
    title: 'reverse-proxy-https-assistant',
    data: { programId: 'reverse-proxy-https-assistant', files: programDraftFiles('reverse-proxy-https-assistant', 'data/programs/reverse-proxy-https-assistant/program.yaml', validProgramYaml) },
    validation: { ok: true, errors: [], warnings: [] },
  });
  recordAuthoringArtifact(completedProgramSession, {
    type: 'authoring_verification',
    title: 'Verification · reverse-proxy-https-assistant',
    status: 'passed',
    data: { sourceArtifactId: completedProgramDraft.id, kind: 'program', programId: 'reverse-proxy-https-assistant', ok: true, checks: [], errors: [], warnings: [] },
    validation: { ok: true, errors: [], warnings: [] },
  });
  assert.strictEqual(completedProgramSession.stage, 'done', 'Program 验证通过后会进入 done 阶段');
  const followupEditSession = followupManager.ensureForMessage({ ideSessionId: 'sess-followup-program', message: '目标 VPS ID 不要这种，我需要选择 1Shell 已经添加的 VPS，能够直接点击，不需要我输入', context: {}, entry: 'studio' });
  assert(followupEditSession, 'Program done 后的自然语言追改必须自动重新进入 Authoring Session');
  assert.strictEqual(followupEditSession.intent, 'edit_program', 'Program done 后的自然语言追改必须识别为 edit_program');
  assert.strictEqual(followupEditSession.facts.targetProgramId, 'reverse-proxy-https-assistant', '追改 session 必须继承最近验证通过的 Program ID');
  const followupPrompt = createAuthoringPromptBlock(followupEditSession);
  assert(followupPrompt.includes('target_program_id: reverse-proxy-https-assistant'), '追改 prompt 必须注入目标 Program ID');
  assert(followupPrompt.includes('不要要求用户重新发起 session'), '追改 prompt 必须禁止让用户重新发起 session');

  function createApprovedProgramCommitSession(programId, filePath, content = validProgramYaml) {
    const files = programDraftFiles(programId, filePath, content);
    const commitSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: `sess-${programId}`, message: `创建 Program ${programId}`, context: {}, entry: 'studio' });
    commitSession.stage = 'draft';
    const commitDraft = recordAuthoringArtifact(commitSession, {
      type: 'program_draft',
      title: programId,
      data: {
        programId,
        files,
      },
      validation: { ok: true, errors: [], warnings: [] },
    });
    const approval = recordCommitApprovalRequest(commitSession, {
      artifactId: commitDraft.id,
      summary: 'test commit',
      files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') })),
      validation: { ok: true, errors: [], warnings: [] },
    });
    recordAuthoringReply(commitSession, { interactionId: approval.id, value: 'approve', text: '确认创建 Program 并写入文件' });
    return { commitSession, commitDraft };
  }

  const draft = recordAuthoringArtifact(session, {
    type: 'program_draft',
    title: 'reverse-proxy-cert',
    data: { files: programDraftFiles('reverse-proxy-cert', 'data/programs/reverse-proxy-cert/program.yaml', validProgramYaml) },
  });
  assert(draft, '必须能创建 Program Draft artifact');
  assert.strictEqual(session.stage, 'review', '创建 draft 后必须推进到 review 阶段');
  const stillBlocked = gateAuthoringTool(session, 'write_file');
  assert(stillBlocked?.is_error, 'review 阶段未批准 commit 仍不能 write_file');

  const skillDetected = detectAuthoringIntent('创建一个 Skill，用来生成 Program。', {}, 'studio');
  assert.strictEqual(skillDetected.shouldStart, true, 'Skill 创建请求必须触发 Authoring Flow');
  assert.strictEqual(skillDetected.intent, 'create_skill', 'Skill 创建请求必须识别为 create_skill');

  const bundleSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-bundle-artifact', message: '创建 Bundle smoke-bundle-e2e', context: {}, entry: 'studio' });
  bundleSession.stage = 'spec';
  assert.deepStrictEqual(requiredAuthoringToolsForStage(bundleSession), ['create_program_spec'], 'Bundle spec 阶段必须先要求 Program spec artifact');
  assert(requiredAuthoringToolMessage(bundleSession).includes('Bundle 当前先创建 Program artifact'), 'Bundle 阶段违规提示必须说明当前先创建 Program artifact');

  const testSkillId = `__authoring-skill-test-${Date.now()}`;
  const testSkillDir = path.join(ROOT_DIR, 'data', 'skills', testSkillId);
  try {
    let skillReloadedForSkill = false;
    let skillLoadedForSkill = false;
    const skillSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-skill-artifact', message: `创建 Skill ${testSkillId}`, context: {}, entry: 'studio' });
    skillSession.stage = 'spec';
    assert.deepStrictEqual(requiredAuthoringToolsForStage(skillSession), ['create_skill_spec'], 'Skill spec 阶段必须要求 create_skill_spec');
    assert.strictEqual(gateAuthoringTool(skillSession, 'create_skill_spec'), null, 'spec 阶段必须允许 create_skill_spec');
    const skillTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: {
        reload: () => { skillReloadedForSkill = true; skillLoadedForSkill = true; return 1; },
        getSkill: (id) => (skillLoadedForSkill && id === testSkillId ? { id, name: 'Authoring Skill Test' } : null),
        listSkills: () => [],
      },
      programEngine: { reload: () => ({ errors: [] }) },
      auditService: { log: () => {} },
    });
    const skillSocket = { emit: () => {} };
    const invalidProgramSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-invalid-draft', message: '创作一个程序 bad-program', context: {}, entry: 'studio' });
    invalidProgramSession.stage = 'draft';
    const invalidProgramDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: invalidProgramSession.id,
      programId: 'bad-program',
      files: [{
        path: 'data/programs/bad-program/program.yaml',
        content: `name: Bad Program
enabled: false
hosts: all
actions:
  run_it:
    steps:
      - id: do_it
        type: exec
        command: echo bad
      - id: render_result
        type: render
        format: keyvalue
        title: 结果
        from: do_it
`,
      }],
    }, { socket: skillSocket, sessionId: 'sess-program-invalid-draft', safeMode: false, session: { authoringSession: invalidProgramSession } });
    assert.strictEqual(invalidProgramDraftResult.is_error, false, invalidProgramDraftResult.content);
    assert(invalidProgramDraftResult.content.includes('update_authoring_draft'), 'Program Draft 校验失败后必须提示增量修复而不是重建或交给用户');
    const invalidProgramDraft = invalidProgramSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(invalidProgramDraft.validation.ok, false, 'Program Draft 预校验必须拦截真实 schema 错误');
    assert.strictEqual(invalidProgramSession.stage, 'draft', '无效 Program Draft 必须停留在 draft 阶段以便 AI 直接重写');
    assert(invalidProgramDraft.validation.errors.some((item) => item.includes('triggers 数组不能为空')), 'Program Draft 必须提前发现 triggers 缺失');
    assert(invalidProgramDraft.validation.errors.some((item) => item.includes('必须有 run 字段')), 'Program Draft 必须提前发现 exec step 使用 command 而不是 run');
    invalidProgramSession.stage = 'review';
    const invalidApprovalResult = await skillTools.handle('request_commit_approval', { sessionId: invalidProgramSession.id, artifactId: invalidProgramDraft.id, summary: '不应批准无效 Program' }, { socket: skillSocket, sessionId: 'sess-program-invalid-draft', safeMode: false, session: { authoringSession: invalidProgramSession } });
    assert.strictEqual(invalidApprovalResult.is_error, true, '无效 Program Draft 不能进入 commit approval');
    assert.strictEqual(invalidProgramSession.stage, 'draft', '审批前复检失败必须自动回到 draft 阶段');

    const invalidUiSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-invalid-ui', message: '创作一个程序 invalid-ui-program', context: {}, entry: 'studio' });
    const invalidUiFiles = programDraftFiles('invalid-ui-program', 'data/programs/invalid-ui-program/program.yaml', validProgramYaml).map((file) => file.path.endsWith('/ui/App.jsx')
      ? { ...file, content: "const { React, ReactDOM, $oneShell } = window;\nfunction App() {\n  return <button onClick={() => $oneShell.runAction('issue_certificate', {})}>run</button>;\n}\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n" }
      : file);
    const invalidUiDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: invalidUiSession.id,
      programId: 'invalid-ui-program',
      files: invalidUiFiles,
    }, { socket: skillSocket, sessionId: 'sess-program-invalid-ui', safeMode: false, session: { authoringSession: invalidUiSession } });
    assert.strictEqual(invalidUiDraftResult.is_error, false, invalidUiDraftResult.content);
    const invalidUiDraft = invalidUiSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(invalidUiDraft.validation.ok, false, 'Program UI runAction 缺少 hostId/inputs 时必须校验失败');
    assert(invalidUiDraft.validation.errors.some((item) => item.includes('runAction 必须传入 { hostId, inputs }')), 'Program UI 预检必须提前发现 hostId 请求体错误');

    const hardcodedHostUiSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-hardcoded-host-ui', message: '创作一个程序 hardcoded-host-ui-program', context: {}, entry: 'studio' });
    const hardcodedHostUiFiles = programDraftFiles('hardcoded-host-ui-program', 'data/programs/hardcoded-host-ui-program/program.yaml', validProgramYaml).map((file) => file.path.endsWith('/ui/App.jsx')
      ? { ...file, content: "const { React, ReactDOM, $oneShell } = window;\nconst HOSTS = [{ id: 'local', label: '本机' }];\nfunction App() {\n  const snapshot = $oneShell.useProgram();\n  const [selectedHostId, setSelectedHostId] = React.useState(HOSTS[0].id);\n  return <div>{HOSTS.map((host) => <button key={host.id} onClick={() => setSelectedHostId(host.id)}>{host.label}</button>)}<button onClick={() => $oneShell.runAction('issue_certificate', { hostId: selectedHostId, inputs: {} })}>{snapshot.program ? snapshot.program.name : 'run'}</button></div>;\n}\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n" }
      : file);
    const hardcodedHostUiDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: hardcodedHostUiSession.id,
      programId: 'hardcoded-host-ui-program',
      files: hardcodedHostUiFiles,
    }, { socket: skillSocket, sessionId: 'sess-program-hardcoded-host-ui', safeMode: false, session: { authoringSession: hardcodedHostUiSession } });
    assert.strictEqual(hardcodedHostUiDraftResult.is_error, false, hardcodedHostUiDraftResult.content);
    const hardcodedHostUiDraft = hardcodedHostUiSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(hardcodedHostUiDraft.validation.ok, false, 'Program UI 不能 hardcode HOSTS/VPS 列表');
    assert(hardcodedHostUiDraft.validation.errors.some((item) => item.includes('hardcode HOSTS/VPS')), 'Program UI 预检必须提前发现 hardcoded HOSTS');

    const snapshotHostUiSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-snapshot-host-ui', message: '创作一个程序 snapshot-host-ui-program', context: {}, entry: 'studio' });
    const snapshotHostUiFiles = programDraftFiles('snapshot-host-ui-program', 'data/programs/snapshot-host-ui-program/program.yaml', validProgramYaml).map((file) => file.path.endsWith('/ui/App.jsx')
      ? { ...file, content: "const { React, ReactDOM, $oneShell } = window;\nfunction App() {\n  const snapshot = $oneShell.useProgram();\n  const [selectedHostId, setSelectedHostId] = React.useState(snapshot.currentHostId || '');\n  return <button onClick={() => $oneShell.runAction('issue_certificate', { hostId: selectedHostId, inputs: {} })}>run</button>;\n}\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n" }
      : file);
    const snapshotHostUiDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: snapshotHostUiSession.id,
      programId: 'snapshot-host-ui-program',
      files: snapshotHostUiFiles,
    }, { socket: skillSocket, sessionId: 'sess-program-snapshot-host-ui', safeMode: false, session: { authoringSession: snapshotHostUiSession } });
    assert.strictEqual(snapshotHostUiDraftResult.is_error, false, snapshotHostUiDraftResult.content);
    const snapshotHostUiDraft = snapshotHostUiSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(snapshotHostUiDraft.validation.ok, false, 'Program UI 不能读取不存在的 snapshot.currentHostId');
    assert(snapshotHostUiDraft.validation.errors.some((item) => item.includes('snapshot.hostId/currentHostId')), 'Program UI 预检必须提前发现 snapshot.currentHostId/currentHostId');

    const dynamicHostUiSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-dynamic-host-ui', message: '创作一个程序 dynamic-host-ui-program', context: {}, entry: 'studio' });
    const dynamicHostUiDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: dynamicHostUiSession.id,
      programId: 'dynamic-host-ui-program',
      files: programDraftFiles('dynamic-host-ui-program', 'data/programs/dynamic-host-ui-program/program.yaml', validProgramYaml),
    }, { socket: skillSocket, sessionId: 'sess-program-dynamic-host-ui', safeMode: false, session: { authoringSession: dynamicHostUiSession } });
    assert.strictEqual(dynamicHostUiDraftResult.is_error, false, dynamicHostUiDraftResult.content);
    const dynamicHostUiDraft = dynamicHostUiSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(dynamicHostUiDraft.validation.ok, true, dynamicHostUiDraft.validation.errors.join('\n'));

    const aiPhaseYaml = validProgramYaml
      .replace('name: 反代端口证书申请', 'name: AI Phase Program')
      .replace('run: echo ok\n        verify:\n          exit_code: 0\n          stdout_contains: ok', 'type: ai\n        prompt: |\n          调用 report_phase({ phase: "check", status: "running", message: "检查中" }) 后完成任务');
    const staticPhaseUiSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-static-phase-ui', message: '创作一个程序 static-phase-ui-program', context: {}, entry: 'studio' });
    const staticPhaseUiFiles = programDraftFiles('static-phase-ui-program', 'data/programs/static-phase-ui-program/program.yaml', aiPhaseYaml).map((file) => file.path.endsWith('/ui/App.jsx')
      ? { ...file, content: "const { React, ReactDOM, $oneShell } = window;\nfunction App() {\n  const program = $oneShell.useProgram();\n  const hostId = program.hosts && program.hosts[0] ? program.hosts[0].id : 'local';\n  const phases = [{ id: 'check', label: '检查' }];\n  return <div><button onClick={() => $oneShell.runAction('issue_certificate', { hostId, inputs: {} })}>run</button>{phases.map((phase) => <div key={phase.id}>{phase.label}</div>)}</div>;\n}\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n" }
      : file);
    const staticPhaseUiDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: staticPhaseUiSession.id,
      programId: 'static-phase-ui-program',
      files: staticPhaseUiFiles,
    }, { socket: skillSocket, sessionId: 'sess-program-static-phase-ui', safeMode: false, session: { authoringSession: staticPhaseUiSession } });
    assert.strictEqual(staticPhaseUiDraftResult.is_error, false, staticPhaseUiDraftResult.content);
    const staticPhaseUiDraft = staticPhaseUiSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(staticPhaseUiDraft.validation.ok, false, '使用 report_phase 的 AI 工作流 UI 不能只静态渲染阶段卡片');
    assert(staticPhaseUiDraft.validation.errors.some((item) => item.includes('AI 工作流 UI 未正确消费 report_phase 事件') || item.includes('getEvents') || item.includes('type="phase"')), 'AI 工作流 UI 预检必须要求 getEvents/subscribe/phase 状态映射');

    const segmentedProgramSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-segmented-draft', message: '创作一个程序 segmented-program', context: {}, entry: 'studio' });
    const segmentedStartResult = await skillTools.handle('start_program_draft', {
      sessionId: segmentedProgramSession.id,
      programId: 'segmented-program',
    }, { socket: skillSocket, sessionId: 'sess-program-segmented-draft', safeMode: false, session: { authoringSession: segmentedProgramSession } });
    assert.strictEqual(segmentedStartResult.is_error, false, segmentedStartResult.content);
    assert(segmentedStartResult.content.includes('分文件补齐'), 'start_program_draft 必须提示分文件补齐');
    const segmentedDraft = segmentedProgramSession.artifacts.find((item) => item.type === 'program_draft');
    assert(segmentedDraft, 'start_program_draft 必须创建 Program Draft artifact');
    assert.strictEqual(segmentedDraft.validation.ok, false, '空 Program Draft 必须等待分文件补齐');
    const segmentedPatchResult = await skillTools.handle('update_authoring_draft', {
      sessionId: segmentedProgramSession.id,
      artifactId: segmentedDraft.id,
      files: programDraftFiles('segmented-program', 'data/programs/segmented-program/program.yaml', validProgramYaml.replace('反代端口证书申请', 'Segmented Program')),
    }, { socket: skillSocket, sessionId: 'sess-program-segmented-draft', safeMode: false, session: { authoringSession: segmentedProgramSession } });
    assert.strictEqual(segmentedPatchResult.is_error, false, segmentedPatchResult.content);
    assert.strictEqual(segmentedDraft.validation.ok, true, segmentedDraft.validation.errors.join('\n'));
    assert.strictEqual(segmentedProgramSession.stage, 'review', '分段补齐通过后必须进入 review 阶段');

    const repairProgramSession = new AuthoringSessionManager().ensureForMessage({ ideSessionId: 'sess-program-repair-draft', message: '创作一个程序 repair-program', context: {}, entry: 'studio' });
    const repairProgramYaml = validProgramYaml.replace('hosts: all\n', 'inputs:\n  notes:\n    type: textarea\n    label: 备注\n');
    const repairDraftResult = await skillTools.handle('create_program_draft', {
      sessionId: repairProgramSession.id,
      programId: 'repair-program',
      files: programDraftFiles('repair-program', 'data/programs/repair-program/program.yaml', repairProgramYaml),
    }, { socket: skillSocket, sessionId: 'sess-program-repair-draft', safeMode: false, session: { authoringSession: repairProgramSession } });
    assert.strictEqual(repairDraftResult.is_error, false, repairDraftResult.content);
    const repairDraft = repairProgramSession.artifacts.find((item) => item.type === 'program_draft');
    assert.strictEqual(repairProgramSession.stage, 'draft', '无效 Program Draft 必须停留 draft 等待增量修复');
    assert.strictEqual(repairDraft.validation.ok, false, '带 textarea 和缺 hosts 的 Program Draft 必须校验失败');
    const repairResult = await skillTools.handle('update_authoring_draft', {
      sessionId: repairProgramSession.id,
      artifactId: repairDraft.id,
      files: [{ path: 'data/programs/repair-program/program.yaml', content: validProgramYaml.replace('反代端口证书申请', 'Repair Program') }],
    }, { socket: skillSocket, sessionId: 'sess-program-repair-draft', safeMode: false, session: { authoringSession: repairProgramSession } });
    assert.strictEqual(repairResult.is_error, false, repairResult.content);
    assert(repairResult.content.includes('已增量修复并通过 validation'), 'update_authoring_draft 应提示增量修复成功');
    assert.strictEqual(repairDraft.validation.ok, true, repairDraft.validation.errors.join('\n'));
    assert.strictEqual(repairProgramSession.stage, 'review', '增量修复通过后必须回到 review 阶段');
    assert.strictEqual(repairDraft.data.files.length, 5, '增量修复不能丢失未修改的 UI artifact 文件');

    const skillSpecResult = await skillTools.handle('create_skill_spec', {
      sessionId: skillSession.id,
      skillId: testSkillId,
      name: 'Authoring Skill Test',
      goal: '测试 Skill 创作链路',
      triggerScenarios: ['用户要求生成 Program 草案'],
      inputs: [{ id: 'goal', label: '目标' }],
      rules: ['必须先生成可审查草案'],
      workflows: ['生成 Skill 文件夹草案'],
      references: ['program-schema.md'],
      risks: ['Skill 与 Program 边界混用'],
    }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillSpecResult.is_error, false, skillSpecResult.content);
    assert.strictEqual(skillSession.stage, 'plan', 'create_skill_spec 后必须进入 plan 阶段');
    skillSession.stage = 'draft';
    assert.deepStrictEqual(requiredAuthoringToolsForStage(skillSession), ['create_skill_draft'], 'Skill draft 阶段必须要求 create_skill_draft');
    const skillFiles = [
      { path: `data/skills/${testSkillId}/SKILL.md`, content: `---\nname: Authoring Skill Test\ndescription: Test skill authoring path\n---\n\n# Authoring Skill Test\n` },
      { path: `data/skills/${testSkillId}/rules/constraints.md`, content: '# Constraints\n\n- Keep artifacts staged.\n' },
      { path: `data/skills/${testSkillId}/workflows/generate.md`, content: '# Generate\n\nCreate a draft first.\n' },
    ];
    const skillDraftResult = await skillTools.handle('create_skill_draft', {
      sessionId: skillSession.id,
      skillId: testSkillId,
      files: skillFiles,
    }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillDraftResult.is_error, false, skillDraftResult.content);
    const skillDraft = skillSession.artifacts.find((item) => item.type === 'skill_draft');
    assert(skillDraft, '必须能创建 Skill Draft artifact');
    assert.strictEqual(skillDraft.validation.ok, true, skillDraft.validation.errors.join('\n'));
    const skillValidationResult = await skillTools.handle('validate_skill_draft', { sessionId: skillSession.id, artifactId: skillDraft.id }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillValidationResult.is_error, false, skillValidationResult.content);
    const skillApprovalResult = await skillTools.handle('request_commit_approval', { sessionId: skillSession.id, artifactId: skillDraft.id, summary: '写入 Skill 文件夹草案' }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillApprovalResult.is_error, false, skillApprovalResult.content);
    const skillApproval = skillSession.interactions.find((item) => item.kind === 'commit_approval');
    assert(skillApproval, 'Skill draft 必须能请求 commit approval');
    assert.strictEqual(skillApproval.options[0].label, '确认创建 Skill 并写入文件', 'Skill commit approval 必须使用明确 Skill 文案');
    assert.strictEqual(skillApproval.options[0].risk, undefined, 'Skill commit approval 的确认按钮不应显示风险标签');
    assert.strictEqual(skillApproval.options[1].recommended, undefined, 'Skill commit approval 不应默认推荐暂不写入');
    recordAuthoringReply(skillSession, { interactionId: skillApproval.id, value: 'approve', text: '确认创建 Skill 并写入文件' });
    const skillCommitResult = await skillTools.handle('commit_authoring_artifact', { sessionId: skillSession.id, artifactId: skillDraft.id }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillCommitResult.is_error, false, skillCommitResult.content);
    assert(fs.existsSync(path.join(ROOT_DIR, `data/skills/${testSkillId}/SKILL.md`)), 'Skill commit 必须写入 SKILL.md');
    assert(skillReloadedForSkill, 'Skill commit 后必须 reload registry');
    const skillVerifyResult = await skillTools.handle('verify_authoring_artifact', { sessionId: skillSession.id, artifactId: skillDraft.id }, { socket: skillSocket, sessionId: 'sess-skill-artifact', safeMode: false, session: { authoringSession: skillSession } });
    assert.strictEqual(skillVerifyResult.is_error, false, skillVerifyResult.content);
    assert.strictEqual(skillSession.stage, 'done', 'Skill 验证通过后必须进入 done 阶段');

  } finally {
    fs.rmSync(testSkillDir, { recursive: true, force: true });
    fs.rmSync(`${testSkillDir}-bad`, { recursive: true, force: true });
  }

  let commitBlocked = gateAuthoringTool(session, 'commit_authoring_artifact');
  assert(commitBlocked?.is_error, 'review 阶段不能直接 commit artifact');
  const commitRequest = recordCommitApprovalRequest(session, {
    artifactId: draft.id,
    summary: '写入反代端口证书申请 Program 草案',
    files: [{ path: 'data/programs/reverse-proxy-cert/program.yaml', bytes: 80 }],
    dangerousActions: ['证书申请', 'Cloudflare API key'],
    irreversibleActions: ['写入 data/programs 下的新 Program 文件'],
    validation: { ok: true, errors: [], warnings: [] },
  });
  assert(commitRequest, '必须能创建 commit approval interaction');
  assert.strictEqual(commitRequest.options[0].risk, undefined, 'commit approval 的确认按钮不应显示高危选项标签');
  assert.strictEqual(commitRequest.options[1].risk, undefined, 'commit approval 的暂不写入按钮不应显示低危选项标签');
  assert.strictEqual(commitRequest.options[1].recommended, undefined, 'commit approval 不应默认推荐暂不写入');
  assert.strictEqual(session.stage, 'review', '请求 commit approval 时仍停留在 review');
  commitBlocked = gateAuthoringTool(session, 'commit_authoring_artifact');
  assert(commitBlocked?.is_error, '用户批准前 commit_authoring_artifact 必须被阻断');
  const commitReply = recordAuthoringReply(session, { interactionId: commitRequest.id, value: 'approve', text: '确认创建 Program 并写入文件' });
  assert(commitReply, '必须能记录 commit approval');
  assert.strictEqual(session.approvals.commit, true, '批准后 commit approval 必须为 true');
  assert.strictEqual(session.approvals.commitArtifactId, draft.id, '批准必须绑定具体 draft artifact');
  assert.strictEqual(session.stage, 'commit', '批准后必须进入 commit 阶段');
  assert.strictEqual(gateAuthoringTool(session, 'commit_authoring_artifact'), null, '批准后只能放行 commit_authoring_artifact');
  assert(gateAuthoringTool(session, 'write_file')?.is_error, '批准后仍不能用 write_file 绕过 artifact commit');

  const testProgramId = `authoring-session-test-${Date.now()}`;
  const testDir = path.join(ROOT_DIR, 'data', 'programs', testProgramId);
  const testFile = `data/programs/${testProgramId}/program.yaml`;
  try {
    const { commitSession, commitDraft } = createApprovedProgramCommitSession(testProgramId, testFile, validProgramYaml.replace('反代端口证书申请', 'Authoring Session Test'));
    let skillReloaded = false;
    let programReloaded = false;
    const ideTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => { skillReloaded = true; }, listSkills: () => [] },
      programEngine: { reload: () => { programReloaded = true; return { errors: [] }; } },
      auditService: { log: () => {} },
    });
    const socket = { emit: () => {} };
    const commitResult = await ideTools.handle('commit_authoring_artifact', { sessionId: commitSession.id, artifactId: commitDraft.id }, { socket, sessionId: 'sess-commit-test', safeMode: false, session: { authoringSession: commitSession } });
    assert.strictEqual(commitResult.is_error, false, commitResult.content);
    assert(fs.existsSync(path.join(ROOT_DIR, testFile)), 'commit_authoring_artifact 必须写入 artifact 声明的文件');
    assert(skillReloaded, 'commit 后必须 reload skill registry');
    assert(programReloaded, 'commit 后必须 reload program registry');
    assert.strictEqual(commitSession.stage, 'verify', 'commit 后必须进入 verify 阶段');
    assert(gateAuthoringTool(commitSession, 'write_file')?.is_error, 'verify 阶段仍不能任意 write_file');
    const verifyResult = await ideTools.handle('verify_authoring_artifact', { sessionId: commitSession.id, artifactId: commitDraft.id }, { socket, sessionId: 'sess-commit-test', safeMode: false, session: { authoringSession: commitSession } });
    assert.strictEqual(verifyResult.is_error, false, verifyResult.content);
    assert.strictEqual(commitSession.stage, 'done', '验证通过后必须进入 done 阶段');
    const verification = commitSession.artifacts.find((item) => item.type === 'authoring_verification');
    assert(verification, '验证必须生成 authoring_verification artifact');
    assert.strictEqual(verification.status, 'passed', '验证成功 artifact 状态必须是 passed');
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const commitRollbackProgramId = `authoring-session-commit-rollback-${Date.now()}`;
  const commitRollbackDir = path.join(ROOT_DIR, 'data', 'programs', commitRollbackProgramId);
  const commitRollbackFile = `data/programs/${commitRollbackProgramId}/program.yaml`;
  try {
    const { commitSession, commitDraft } = createApprovedProgramCommitSession(commitRollbackProgramId, commitRollbackFile, validProgramYaml.replace('反代端口证书申请', 'Commit Rollback Test'));
    const rollbackTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => {}, listSkills: () => [] },
      programEngine: { reload: () => ({ errors: [`${commitRollbackProgramId}: YAML schema mismatch`] }) },
      auditService: { log: () => {} },
    });
    const rollbackResult = await rollbackTools.handle('commit_authoring_artifact', { sessionId: commitSession.id, artifactId: commitDraft.id }, { socket: { emit: () => {} }, sessionId: 'sess-commit-rollback', safeMode: false, session: { authoringSession: commitSession } });
    assert.strictEqual(rollbackResult.is_error, true, 'commit 后 registry 加载当前 Program 失败必须返回错误');
    assert(!fs.existsSync(path.join(ROOT_DIR, commitRollbackFile)), 'commit registry 失败必须删除新写入的 Program 文件');
    assert(!fs.existsSync(commitRollbackDir), 'commit registry 失败必须清理新建空目录');
    assert.strictEqual(commitSession.stage, 'draft', 'commit registry 失败后必须回到 draft 阶段');
    assert.strictEqual(commitSession.approvals.commit, false, 'commit registry 失败后必须撤销 commit approval');
    assert.strictEqual(commitDraft.status, 'needs_fix', 'commit registry 失败后源 draft 必须标记 needs_fix');
  } finally {
    fs.rmSync(commitRollbackDir, { recursive: true, force: true });
  }

  const failedProgramId = `authoring-session-fail-${Date.now()}`;
  const failedDir = path.join(ROOT_DIR, 'data', 'programs', failedProgramId);
  const failedFile = `data/programs/${failedProgramId}/program.yaml`;
  try {
    const { commitSession: failedSession, commitDraft: failedDraft } = createApprovedProgramCommitSession(failedProgramId, failedFile, validProgramYaml.replace('反代端口证书申请', 'Failed Verification Test'));
    let reloadCount = 0;
    const failedTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => {}, listSkills: () => [] },
      programEngine: { reload: () => {
        reloadCount += 1;
        return reloadCount === 1 ? { errors: [] } : { errors: [`${failedProgramId}: YAML schema mismatch`] };
      } },
      auditService: { log: () => {} },
    });
    const failedSocket = { emit: () => {} };
    const failedCommit = await failedTools.handle('commit_authoring_artifact', { sessionId: failedSession.id, artifactId: failedDraft.id }, { socket: failedSocket, sessionId: 'sess-verify-fail', safeMode: false, session: { authoringSession: failedSession } });
    assert.strictEqual(failedCommit.is_error, false, failedCommit.content);
    assert(fs.existsSync(path.join(ROOT_DIR, failedFile)), 'verify 前必须已经写入 Program 文件');
    const failedResult = await failedTools.handle('verify_authoring_artifact', { sessionId: failedSession.id, artifactId: failedDraft.id }, { socket: failedSocket, sessionId: 'sess-verify-fail', safeMode: false, session: { authoringSession: failedSession } });
    assert.strictEqual(failedResult.is_error, true, '加载错误时 verify 必须失败');
    assert(!fs.existsSync(path.join(ROOT_DIR, failedFile)), 'verify 失败必须删除本次新建的 Program 文件');
    assert(!fs.existsSync(failedDir), 'verify 失败必须清理本次新建空目录');
    assert.strictEqual(failedSession.stage, 'draft', '验证失败后必须回到 draft 阶段');
    assert.strictEqual(failedSession.approvals.commit, false, '验证失败后必须撤销 commit approval');
    assert.strictEqual(failedDraft.status, 'needs_fix', '验证失败后源 draft 必须标记 needs_fix');
  } finally {
    fs.rmSync(failedDir, { recursive: true, force: true });
  }

  const restoreProgramId = `authoring-session-restore-${Date.now()}`;
  const restoreDir = path.join(ROOT_DIR, 'data', 'programs', restoreProgramId);
  const restoreFile = `data/programs/${restoreProgramId}/program.yaml`;
  const restoreAbs = path.join(ROOT_DIR, restoreFile);
  const originalContent = validProgramYaml.replace('反代端口证书申请', 'Original Restore Test');
  try {
    fs.mkdirSync(restoreDir, { recursive: true });
    fs.writeFileSync(restoreAbs, originalContent, 'utf8');
    const { commitSession: restoreSession, commitDraft: restoreDraft } = createApprovedProgramCommitSession(restoreProgramId, restoreFile, validProgramYaml.replace('反代端口证书申请', 'Changed Restore Test'));
    let reloadCount = 0;
    const restoreTools = createIdeTools({
      hostService: { listHosts: () => [] },
      skillRegistry: { reload: () => {}, listSkills: () => [] },
      programEngine: { reload: () => {
        reloadCount += 1;
        return reloadCount === 1 ? { errors: [] } : { errors: [`${restoreProgramId}: YAML schema mismatch`] };
      } },
      auditService: { log: () => {} },
    });
    const restoreSocket = { emit: () => {} };
    const restoreCommit = await restoreTools.handle('commit_authoring_artifact', { sessionId: restoreSession.id, artifactId: restoreDraft.id }, { socket: restoreSocket, sessionId: 'sess-verify-restore', safeMode: false, session: { authoringSession: restoreSession } });
    assert.strictEqual(restoreCommit.is_error, false, restoreCommit.content);
    assert.strictEqual(fs.readFileSync(restoreAbs, 'utf8'), restoreDraft.data.files[0].content, 'commit 必须先覆盖既有文件');
    const restoreResult = await restoreTools.handle('verify_authoring_artifact', { sessionId: restoreSession.id, artifactId: restoreDraft.id }, { socket: restoreSocket, sessionId: 'sess-verify-restore', safeMode: false, session: { authoringSession: restoreSession } });
    assert.strictEqual(restoreResult.is_error, true, '既有文件 verify 失败必须返回错误');
    assert.strictEqual(fs.readFileSync(restoreAbs, 'utf8'), originalContent, 'verify 失败必须恢复既有 Program 文件内容');
    assert.strictEqual(restoreSession.stage, 'draft', '既有文件恢复后必须回到 draft 阶段');
  } finally {
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }

  console.log('authoring session tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
