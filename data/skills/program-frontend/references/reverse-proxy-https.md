# 反向代理与 HTTPS 前端结构

## 中间 40% 输入区

系统选择：
- 目标 VPS：从 1Shell 已加入 hosts 列表选择，不允许手填。

业务输入：
- `proxy_port`：反代端口，number，required。
- `domain`：绑定域名，string，required。
- `cloudflare_token`：Cloudflare API Token，password，required。
- `enable_https`：是否开启 HTTPS，boolean，默认 true。
- `cloudflare_proxy_mode`：Cloudflare 代理模式，select，`dns_only` / `proxied`，默认 `dns_only`。
- `acme_email`：证书申请邮箱，string，开启 HTTPS 时需要。
- `health_check_path`：验证路径，string，默认 `/`。
- `conflict_policy`：已有同域名配置策略，select，`abort` / `backup_replace`，默认 `abort`。

## 右侧 40% 阶段 / 结果

阶段：
- 输入校验
- 环境检查
- 后端端口验证
- Cloudflare DNS 配置
- 反向代理配置
- 代理服务重载
- HTTPS 证书处理
- HTTP 验证
- HTTPS 验证
- 结果输出

最终结果必须明确：
- 成功 / 部分成功 / 失败。
- 域名。
- HTTP / HTTPS 地址。
- Cloudflare DNS 和代理模式。
- 证书状态。
- 代理服务和配置路径。
- 后端端口验证结果。
- 如果失败，失败阶段和下一步建议。
