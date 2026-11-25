# 使用 ChatGPT 订阅

本机实现采用 OpenAI 官方 [Sign in with ChatGPT 开源应用授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)，不是聊天网页 Cookie 或未公开的 backend-api。

## 连接

在本机 `.env` 设置 `LLM_PROVIDER=chatgpt_subscription`，仍保留 `MODEL_CALLS_ENABLED=true`。已有 DeepSeek API 密钥保留，但订阅模式不会使用它，也不会自动付费兜底。

启动授权入口（命令持续运行，完成后 Ctrl+C）：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml run --rm --no-deps --name beihang-paian-chatgpt-login api node scripts/chatgpt-login.ts
```

打开 **http://127.0.0.1:1456**，点击 **Continue with ChatGPT**，在 OpenAI 页面登录并允许北航拍案使用订阅额度。关闭本应用使用额外付费积分的权限，再选择账号实际可用的模型。回调必须保持 `127.0.0.1`，不要替换成 `localhost`。临时入口只监听本机，写操作校验 Origin 与 CSRF，回调校验 state、有效期、PKCE、签名、issuer、audience、nonce 与账号身份。

如网络需要代理，可在 `.env` 中设置 `HTTPS_PROXY`；本机为 `http://127.0.0.1:7890`。代理只用于本适配器访问固定 OpenAI 官方端点。

代码或配置修改后重建：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

## 用量与状态

模型以授权账号返回的目录为准，不能承诺所有订阅账号都能使用某个型号。订阅用量与付费 API 分开记账：回执服务为 `chatgpt_subscription`，金额留空，不能把 token 数或未知费用写成“0 元实付”。官方限额由账号和应用设置决定。本机通过 `CHATGPT_DAILY_REQUEST_LIMIT` 限制任何连续 24 小时的模型请求，默认 100，本机已按用户要求调至 **200**，包含重试与评测；这只是保护订阅用量，不限制保留或展示的消息条数。

订阅额度不足、授权失效时保留待处理资料，按小时等待恢复或重新授权。官方 HTTP 429 或订阅用量事件会为当前账号写入持久化暂停，遵守可用的 Retry-After（无有效提示时一小时），期间所有新消息、历史与评测在发出请求前一起等待；页面显示下次尝试时间。重启不会清除暂停，换账号分别读取各自暂停；时间到达只表示可以再次尝试，不保证官方额度已经恢复。流式调用按输出项与正文段累计 `response.output_text.delta`，用各层 done 事件替换确认文本，必须收到 `response.completed` 才接受结果。订阅的完成通知可能不附带正文，因此使用已累计的分段文本；中途断流不会把部分输出发布。结果不明仍走原回执恢复机制，避免直接重复请求。SIWC 预览不支持 `max_output_tokens`、`temperature` 等字段，因此不沿用付费 API 的单次费用上界推算，也不声称本机能强制服务端输出 token 上限。

提示词依旧使用北航规则；模型改变后另开评测版本，旧版本留在数据库设置的归档键中，不混合计算准确率。每条摘要仍需对照原文复核。

## 保存、重连与断开

授权文件在持久化 `/data/chatgpt/credentials.json`，目录 700、文件 600；包括单独的账号/client 映射、稳定 host ID 和令牌。不得提交、贴入对话或放进浏览器存储。令牌刷新用数据库锁串行化，替换令牌原子保存；重建容器不会产生新 host ID。

再次打开连接入口可以选择账号、重新授权、换模型或断开连接。断开时尝试撤销远端会话并清除本机令牌；远端撤销无法确认时会提示到 ChatGPT 设置中断开。备份数据卷会包含这些凭据，按私密备份保存。

回退 DeepSeek 需主动将 `.env` 的 `LLM_PROVIDER=api` 后重启 API 与 worker；原每天 1 元限制继续有效。订阅模式绝不自动执行回退。

## 调整额度

本机 `.env`：`CHATGPT_DAILY_REQUEST_LIMIT=200`，范围 1–1000；修改后重新创建 API 与 worker 容器；仅修改这个配置无需重建镜像。参数只提高本机的请求保护上限，不清空旧回执或计数，不提高并发，不改变筛选门槛，也不解除官方用量暂停。无效配置拒绝启动，不允许无限调用。付费 API 模式的每天 1 元限额不受影响。

如官方仍返回用量限制，到 ChatGPT **设置 → 用量**，找到“北航拍案”对应连接，检查其订阅用量设置并按需提高。保留额外付费积分权限关闭。Plus 的五小时额度由各应用共享；应用限制调整不能增加订阅本身的总额度，官方页面为准：[OpenAI 官方用量说明](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)。
