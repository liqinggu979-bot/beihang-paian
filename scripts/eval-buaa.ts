// One resumable batch; the worker continues hourly. Uses the same production receipts and 1 CNY cap.
import { evaluateBatch } from "../modules/beihang-evaluation/server.ts";
import { closeDb } from "@aihot/backend/db";
const result=await evaluateBatch(1,{allowHistoryWork:true});
console.log(JSON.stringify(result));
await closeDb();
