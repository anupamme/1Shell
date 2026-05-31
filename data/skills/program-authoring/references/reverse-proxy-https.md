# 反向代理与 HTTPS Program 设计参考

用户说“把端口反代到域名并开启 HTTPS”时，创建 AI 不能只照抄用户说的端口、域名、token。必须扩写成可安全执行的运维程序。

## 必要输入

系统选择：
- 目标 VPS：使用 1Shell hosts 选择器，不进入 inputs。

业务输入：
- `proxy_port`：要反代的本机端口。
- `domain`：绑定域名。
- `cloudflare_token`：Cloudflare API Token。
- `enable_https`：是否开启 HTTPS。
- `cloudflare_proxy_mode`：Cloudflare 代理模式，`dns_only` 或 `proxied`。默认 `dns_only`，避免 ACME 和源站排查被橙云干扰。
- `acme_email`：证书申请邮箱。开启 HTTPS 时需要；不开启 HTTPS 时可不填。
- `health_check_path`：验证路径，默认 `/`。
- `conflict_policy`：遇到已有同域名配置时的处理策略，默认 `abort`，可选 `backup_replace`。

不要把 VPS 系统、Nginx/Caddy 路径、Certbot 安装状态、80/443 占用这些做成输入；这些由运行期探测。

## 阶段设计

建议拆成细阶段：
- `input_validate`：校验域名、端口、邮箱、token 格式。
- `env_check`：检查系统、权限、端口、Web 服务、当前公网 IP。
- `upstream_check`：检查 `127.0.0.1:proxy_port` 是否真实可访问；如果后端不可达，不应继续报告成功。
- `cloudflare_dns`：验证 token、定位 zone、创建/更新 A 记录，按用户选择设置灰云/橙云。
- `proxy_config`：生成反代配置并语法检查。
- `proxy_reload`：reload/restart 代理服务并检查监听。
- `https_issue`：开启 HTTPS 时申请证书；不开启则跳过并标记 done。
- `http_verify`：验证 HTTP 访问。
- `https_verify`：开启 HTTPS 时验证 HTTPS、证书链、域名匹配。
- `result`：输出结果。

## 成功条件

不能只因为“配置写入成功”就报告成功。

成功必须满足：
- DNS 解析到目标 VPS，或明确说明 Cloudflare 代理模式导致源站 IP 不直接暴露。
- 本机 upstream 可访问，不是 connection refused / timeout。
- 反向代理服务配置测试通过并已 reload。
- HTTP 访问不是 502 / 504 / timeout。
- 如果开启 HTTPS，HTTPS 访问不是证书错误、502、504 或 timeout。

## 失败处理

如果出现 502 / 504，必须判定为失败或部分失败，并排查：
- upstream 端口是否监听。
- upstream 是否只监听 127.0.0.1 或 0.0.0.0。
- 代理配置的 upstream 地址是否正确。
- Web 服务错误日志。
- 目标服务是否响应 `health_check_path`。

失败时必须输出失败阶段、证据、已完成内容和下一步建议。
