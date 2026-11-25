// Run inside the API container after placing the private local collector login in /data.
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../packages/backend/src/config.ts";
import { sql } from "../packages/backend/src/db.ts";
import { registerWechatSources, wechatAccounts } from "../modules/beihang-wechat/server.ts";
import { republishSource } from "../packages/backend/src/publication/publish.ts";

if (!existsSync(path.join(config.dataDir,"beihang-wechat.json"))) throw new Error("Private collector login is not configured");
await registerWechatSources();
for(const source of wechatAccounts())await republishSource(source.id);
console.log(`已登记 ${wechatAccounts().length} 个公众号，按持久化到期时间每 48 小时在后台检查。`);
await sql.end();
