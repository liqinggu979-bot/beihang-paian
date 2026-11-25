# 北航拍案

个人使用的北航公开信息站，基于 AIHOT 独立定制。原项目保留在相邻的 `../AIHOT`，本项目不会修改它。本站并非北航官方网站。

每个启用栏目首次启动检查一次，以后按持久化到期时间每 **2880 分钟（48 小时）**检查；采集失败也等下一轮，后台可以手动重试。没有新增时只记录检查结果。消息不设数量目标，不生成固定日报、周报或月报。读者关注重点为学术科技竞赛，以及飞行器设计、飞行器力学的实质进展；其他校园信息仍保留。

另有公众号通过后台网页检索及最新文章补查接入，覆盖航空、无人系统、机械、自动化、宇航、人工智能、计算机、仪器光电、电子信息等方向，关注竞赛、无人机与机器人进展、校园福利及信息化服务。无头浏览器不占用桌面；搜索可能漏收录，站点会注明覆盖范围并区分部分结果和检查失败。详见 [公众号采集模块](modules/beihang-wechat/README.md)。

首版有七类资讯、校园变迁 / 领导变化 / 竞赛记录 / 科研进展专题、搜索、原文索引、RSS、公开 API 与 `beihang_paian` MCP。历史导入以运行日之前一个日历年为边界，每批最多 100 条，支持重复运行。静态名录只有核验日期。

## 本机启动

```bash
cd /home/qinggu/tools/beihang-paian
bash scripts/local-up.sh
```

浏览地址：**http://localhost:3000**。后台：http://localhost:3000/admin；管理员密码在本机 `.env` 的 `ADMIN_PASSWORD` 中。数据库和附件保存在 Compose 数据卷，不随容器重建丢失。

完成模型连接与模型选择后，后台自动整理已采集资料，不需要在浏览器点“开始”。保持 Docker 服务运行即可；关闭网页不会停止整理。首页展示精选；[全部资讯](http://localhost:3000/all) 收录完成摘要的相关资料，专题与原文索引也可直接浏览。48 小时是信源检查间隔，整理队列持续处理，受可用额度限制时等待恢复。

第一次在另一台机器初始化，使用 Node 24 容器：

```bash
docker run --rm -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts
```

然后编辑 `.env`。本机使用 `docker-compose.local.yml` 的主机网络与精确校园地址映射；离开校园网络时清空 `TRUSTED_SOURCE_ADDRESSES_JSON`，使用基础 Compose 文件即可。所有对外端口仅绑定本机。

## 模型与费用

支持通过官方登录使用 ChatGPT 订阅，连接方式见 [订阅授权说明](docs/chatgpt-subscription.md)。本机设置 `LLM_PROVIDER=chatgpt_subscription` 后只用订阅额度；完成登录与模型选择后生效，不自动转为付费 API。本机订阅调用上限已设为连续 24 小时 200 次（`CHATGPT_DAILY_REQUEST_LIMIT=200`），新闻、历史、重试与评测共用；官方订阅限制仍独立生效。以下人民币限额适用于 `LLM_PROVIDER=api`。

API 模式唯一获准的付费文本模型是官方 `deepseek-flash`，配置 `LLM_API_KEY`、`LLM_BASE_URL=https://api.deepseek.com/v1`、`LLM_MODEL=deepseek-flash`、`LLM_EXTRA_JSON={"thinking":{"type":"disabled"}}` 和 `MODEL_CALLS_ENABLED=true`，之后重建/重启 API 与 worker。

按 2026-10-08 核验的官方高峰未命中价格：输入 2 元 / 百万 token，输出 8 元 / 百万 token。每次输入最多 24000 UTF-8 字节，预留 256 个封装 token，输出最多 3000 token。最坏一次 0.072512 元，因此任何连续 24 小时最多 **13 次实际请求（0.942656 元上界）**。新闻、历史、重试、付费评测共享同一限额；命中已保存回执不再次计费。后台降低额度仍有效，提高后台额度不能突破 13 次。

价格、提供商、输入形式或请求配置不能通过核验时不发送请求；当前价格核验于 2026-11-08 到期，届时须重新核对官方价格并更新 `model-budget.ts`。账单里的金额是按高峰价估计，最终以服务商账单为准。来源正文较长时只给模型有限的首尾摘录，并明确标记省略处。

每日限额会影响处理速度：资料全部保留，完成后陆续展示。新资料优先，历史进入低优先级队列。首版关闭付费向量、付费抓取、全文翻译、飞书和 IndexNow。页面访问不触发模型调用。

## 资料、提示词与评测

- [信源验证与参考入口](docs/beihang-sources.md)：8 个启用栏目，各核对 10 篇。
- [逐篇验证记录](docs/source-validation.json)：标题、日期、链接与正文样本。
- [运行、备份与补充信源](docs/beihang-operations.md)。
- [本机交付核验及尚未完成项](docs/beihang-verification.md)。
- [评测说明与当前结果](docs/beihang-evaluation.md)：60 条真实样本分批进行，不把未完成的准确率目标写成结果。
- 分类、主题、来源及提示词：`industry/`；站名、政策、品牌和原文索引：`site/`。
- 历史导入：`scripts/backfill-history.ts`；逐栏目复验：`scripts/verify-sources.ts`。

完整框架技术说明仍在 `docs/`。新增的 0058–0060 迁移只扩展采集间隔的数据库约束至 2880 分钟，原历史迁移没有改动。
