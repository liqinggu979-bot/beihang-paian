import { beijingDate } from "@aihot/contracts/time";
import type { CheckStatus, ReferenceEntry } from "@aihot/contracts/site";
import { Link } from "react-router";
import { monthDayTime } from "../../lib/format";

export function CheckNotice({ status }: { status: CheckStatus }) {
  const failed = status.sources.filter((s) => s.state === "failed" || s.state === "partial");
  return <aside className="mb-5 rounded-xl border border-line bg-surface p-4 text-[13px] leading-relaxed text-ink-3" aria-label="信息检查状态">
    <p className="font-medium text-ink">每 48 小时检查一次 · 真实有用，不凑条数</p>
    <p>{status.checkedAt ? `最近检查：${monthDayTime(status.checkedAt)}（北京时间）` : "尚未完成首次检查"}{failed.length > 0 ? ` · ${failed.length} 个栏目未完整检查` : ""}</p>
    {status.pending > 0 && <p>{status.pending} 条资料待整理{status.modelsEnabled ? "，完成后陆续展示" : "，配置模型后生成摘要"}。没有新增消息时保留已有内容。</p>}
    {status.modelProvider === "chatgpt_subscription" && <p>使用 ChatGPT 订阅额度{status.modelReady ? "，后台自动整理" : "，等待本机登录授权与模型选择"}。</p>}
    {status.budgetPaused && <p>整理调用额度暂不可用，待额度恢复后继续。待处理资料会保留。{status.modelResumeAt && ` 下次尝试：${monthDayTime(status.modelResumeAt)}（北京时间）。`}</p>}
    {status.sources.some((s) => s.coverage === "public-search-and-latest") && <p>公众号通过公开网页搜索并补查最新文章；搜索可能漏收录，检查成功不代表覆盖该账号的全部推送。采集在后台运行。</p>}
    <details className="mt-2"><summary className="cursor-pointer">查看各栏目检查结果</summary><ul className="mt-2 space-y-1">{status.sources.map((s) => <li key={s.id}>{s.name}：{({ unchecked: "待检查", checking: "检查中", failed: "检查失败", partial: "已取得部分资料，检查未完成", updated: "发现新资料", unchanged: "检查成功，无新增" })[s.state]}{s.lastSuccessAt && ` · 最近成功 ${monthDayTime(s.lastSuccessAt)}`}{s.nextCheckAt && ` · 下次 ${monthDayTime(s.nextCheckAt)}`}</li>)}</ul></details>
  </aside>;
}

export function ReferenceList({ entries, title = "已核对的原文索引" }: { entries: ReferenceEntry[]; title?: string }) {
  if (!entries.length) return null;
  return <section className="mb-6" aria-label={title}><h2 className="mb-2 text-[16px] font-semibold text-ink">{title}</h2><p className="mb-3 text-[12px] text-ink-3">近一年公开资料与官方参考入口。日期是原文发布日期；无日期页面只标核验时间。原文索引不等同于模型精选。</p>
    <div className="divide-y divide-line">{entries.map((r) => <article key={r.url} className="py-3"><a href={r.url} target="_blank" rel="noreferrer" className="text-[14px] font-medium text-ink hover:text-accent">{r.title} ↗</a><p className="mt-1 text-[12px] text-ink-3">{r.source} · {r.publishedAt ? `原文发布 ${beijingDate(r.publishedAt)}` : "静态参考，无发布日期"} · 核验 {beijingDate(r.checkedAt)}</p>{r.note && <p className="mt-1 text-[12px] text-ink-3">{r.note}</p>}</article>)}</div>
    <p className="mt-3 text-[12px] text-ink-3"><Link to="/topics" className="text-accent">按专题查阅</Link> · 个人整理，非北航官方网站</p>
  </section>;
}
