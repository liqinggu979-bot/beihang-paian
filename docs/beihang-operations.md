# 运行与维护

从项目根目录执行。本机使用两份 Compose 配置；原 AIHOT 保持独立。

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.local.yml ps
docker compose -f docker-compose.yml -f docker-compose.local.yml logs --tail 80 worker
```

停止不删除数据：`docker compose -f docker-compose.yml -f docker-compose.local.yml stop`。不要用 `down -v`，它会删除数据库和附件卷。

配置修改后用 `up -d` 重新创建相应容器；代码修改后加 `--build`。主页面显示各栏目检查结果、最近成功和下次检查时间；后台信源页可手动重试。手动重试成功后重新计算 48 小时到期时间。失败和成功无新增有不同状态。

本机公众号采集器使用 `deploy/wechat/compose.yaml`，只在 `127.0.0.1:3002` 提供本机接口。统一启动脚本 `bash scripts/local-up.sh` 会先启动它，再启动主站。其普通无头浏览器不占用桌面。原采集工具自己的定时任务关闭，48 小时间隔由主站数据库控制；不要另行开启它默认的高频任务。

公众号登录状态与浏览器资料保存在 `.data/wechat-collector/data/`，本机服务凭据保存在 `.data/wechat-collector/.env`，两者也应纳入本地私密备份。主站 `/data` 的备份已包含主站连接采集器的凭据。需要停止全部服务时，除主站外再停止 `docker compose -f deploy/wechat/compose.yaml stop`。

新增账号在 `industry/wechat-accounts.json` 登记经核对的账号名、微信号和公开账号 ID，验证后在 API 容器执行 `node scripts/setup-wechat.ts`；该命令保留后台暂停状态。不要把账号登录 Cookie 填入这份公开配置。

## 备份

创建本地备份目录后执行：

```bash
mkdir -p .data/backups
chmod 700 .data/backups
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T db pg_dump -U aihot -d aihot > .data/backups/database.sql
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T api tar -C /data -czf - . > .data/backups/data.tgz
cp .env .data/backups/local.env
chmod 600 .data/backups/*
```

数据库、附件/评测进度、`.env` 三者一起保存。备份包含本机密钥，仅由维护者保存。恢复前停止 API、worker 和 web，将 SQL 恢复到空数据库并将附件放回数据卷；恢复已有数据是覆盖操作，应先另存现状。上游的完整恢复说明见 `docs/deploy.md`。

## 补充来源

在后台信源页或 `industry/sources.json` 添加公开官方栏目，设置 `web_list` / RSS、标题、链接、发布日期及正文选择器。间隔设为 2880 分钟，关闭全文公开与转发。采集策略会强制 48 小时，关闭自适应；`seed.ts` 只添加不存在的来源，不覆盖后台修改。

每个新栏目先抽查至少 10 篇，核对标题完整性、年份、正文、分页与重复处理，然后运行：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T worker node scripts/verify-sources.ts
```

复验记录会写在容器项目目录；长期保存时用 `docker compose cp` 导出 `docs/source-validation.json`。采集不到或需要登录的入口先保留为参考链接，不填虚构日期。

## 历史导入

首次批次以已核对的原文样本导入；后续可以抓取近一年资料：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T worker node scripts/backfill-history.ts --limit 100
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T worker node scripts/backfill-history.ts --limit 100 --apply
```

`--apply` 使用本机的 `INGEST_TOKEN` 和原有推送接口，明确标记历史回灌。每批最多 100 条，日期在一年边界内；身份去重和本地检查点可防重复。运行不改变栏目成功检查时间。处理模型摘要仍遵守同一费用限额。容器导入使用持久化 `/data` 的检查点，不把运行日当原文发布日期。
