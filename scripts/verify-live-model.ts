// Complete one grounded campus article through the real pipeline, without changing collection clocks.
import { sql, closeDb } from "@aihot/backend/db";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
const [article]=await sql<{id:string}[]>`SELECT id FROM articles WHERE title LIKE '%王云鹏同志任%党委书记%' ORDER BY discovered_at LIMIT 1`;
if(!article)throw new Error("The verified appointment article has not been imported yet");
const result=await processArticle(article.id);
const [analysis]=await sql`SELECT category,title_zh,summary_zh,score,selected FROM analyses WHERE article_id=${article.id} ORDER BY id DESC LIMIT 1`;
console.log(JSON.stringify({articleId:article.id,result,analysis}));
await stopBoss();await closeDb();
