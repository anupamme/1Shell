export type TaskAuthoringMode = 'new' | 'pack';

export function looksLikeTaskPackRequest(value: string): boolean {
  return /上面|刚才|流程|打包|复用|对话|步骤|过程/.test(String(value || ''));
}

export function buildTaskAuthoringPrompt({ mode, intent }: { mode: TaskAuthoringMode; intent: string }): string {
  const modeText = mode === 'pack' ? '把当前 IDE 对话中的流程打包为 AI 任务' : '从用户目标创建新的 AI 任务';
  const userIntent = String(intent || '').trim() || '用户还没有补充具体目标，请先询问。';
  return [
    '进入 /task 任务创作模式。',
    '',
    `模式：${modeText}`,
    `用户输入：${userIntent}`,
    '',
    '工作方式：',
    '- 这个回合的目标是创作 AI 任务模板，不是直接执行普通工作。',
    '- 任务模板保持简单：几个用户需要填写的输入项，加几张流程步骤卡片。',
    '- 不要设计新的权限系统、审批层、DSL、调度器或第二套 Agent。',
    '- 如果是新任务，先用只读探索把流程推演扎实，再把可复用路径包装成任务；不能凭空猜，也不能只保存通用模板。',
    '- 发现类工具只用于收集上下文；list_hosts、list_scripts、read_remote_file、get_ai_task 或数据库持久化结果可以作为推演依据，但不要当作已经执行了部署/修改。',
    '- 缺少目标主机、仓库地址、分支、端口、运行命令、密钥或清理偏好时，先 ask_user 或 request_secret。',
    '- 如果是打包上面对话，从本 IDE 会话历史里提取已经成功验证的路径，忽略失败分支；缺关键条件时先问用户。',
    '- 需要密钥、token、密码时，使用 request_secret，不要让用户在普通文本里粘贴明文。',
    '- 在 /task 创作模式里不要执行安装、写文件、删除、重启、部署等真实变更；证据不足时在任务描述里标清假设和待执行验证。',
    '- 结构确认后，先调用 preview_ai_task 检查结构，再调用 create_ai_task 保存任务；修改已有任务时用 update_ai_task。',
    '',
    '保存任务的结构如下：',
    '{',
    '  "name": "任务名称",',
    '  "description": "任务说明",',
    '  "inputs": [{ "key": "host", "label": "目标主机", "type": "host", "required": true }],',
    '  "steps": [{ "title": "步骤标题", "instruction": "给 1Shell AI 的执行说明" }]',
    '}',
  ].join('\n');
}
