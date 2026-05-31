---
name: Program 前端结构
icon: "layout"
hidden: false
forceLocal: true
description: 当 AI 型 Program 需要把提示词变量映射成 1Shell 程序界面结构时使用；纯脚本型固定操作不要触发本 Skill。
category: custom
tags:
  - program
  - frontend
  - ui-structure
inputs:
  - name: task
    label: 前端结构需求
    type: string
    required: true
    placeholder: 例如：为一键部署 GitHub 项目设计输入、阶段和结果界面
---

# Program 前端结构

## Always Read
- rules/constraints.md

## Common Tasks

| 用户意图 | 读取 workflow |
|---------|--------------|
| 为 AI 型 Program 设计输入区、阶段区、结果区 | workflows/structure.md |
| 检查 AI 型 Program 前端结构是否过度设计 | workflows/structure.md |

## 不适用场景

纯脚本型 Program 不应触发本 Skill，例如开启/关闭固定项目、重启固定服务、执行固定备份脚本、清理固定缓存目录、查看固定状态命令。这类 Program 的功能来自 `exec` / `render` steps，不需要把前端变成只有展示意义的卡片结构。

如果已经被调用并发现目标是纯脚本型 Program，应返回“不需要额外前端结构”，只保留 1Shell hosts 选择器、必要业务输入和脚本执行结果，不生成阶段卡片或自定义结果卡片。

## 必要输入扩写

前端结构不是只映射用户原话里的字段，而是映射“运行期 AI 安全完成目标必须由用户提供的信息”。

当目标涉及 DNS、HTTPS、反向代理、证书、迁移、备份等运维操作时，必须主动补充用户没说但必须决策的输入，例如证书邮箱、DNS 代理模式、健康检查路径、冲突处理策略。

## Known Gotchas

1. 纯脚本型 Program 不需要本 Skill 设计前端结构；不要把固定脚本结果改成只有展示意义的卡片。
2. VPS 选择是 1Shell 系统主机选择，不是用户手填输入字段。
3. 最终结果属于右侧 40% 结果界面，不是单独生成的卡片文件。
4. 本 skill 不写 Vue、React、iframe、CSS 或自定义前端 artifact。
5. 反向代理与 HTTPS 这类 AI 型 Program 的输入不能只有端口、域名和 token；需要补齐证书、DNS 策略、验证路径和冲突策略。
