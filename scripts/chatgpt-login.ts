// Temporary, loopback-only connection UI. Stop it after connecting; credentials live in /data.
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { sql, closeDb } from '@aihot/backend/db';
import { subscriptionDiagnostic, activateSubscription, completeSubscriptionLogin, disconnectSubscription, prepareSubscriptionLogin, readSubscriptionStore, saveSubscriptionStore, subscriptionCatalog, type PendingLogin } from '@aihot/backend/providers/chatgpt-subscription';

const port = Number(process.argv[2] ?? 1456);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port');
const origin = `http://127.0.0.1:${port}`;
const csrf = randomBytes(32).toString('base64url');
const pending = new Map<string, PendingLogin>();
const html = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
await sql.begin(async tx => {
  await tx`SELECT pg_advisory_xact_lock(hashtext('beihang:chatgpt-session'))`;
  saveSubscriptionStore(readSubscriptionStore());
});
const form = (action: string, body: string) => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}">${body}</form>`;
const shell = (body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>北航拍案 · ChatGPT 连接</title><style>body{font:16px/1.7 system-ui;background:#f4f7f6;color:#263638;margin:0}main{max-width:640px;margin:40px auto;padding:28px;background:white;border-radius:18px}h1{font-size:25px}button,select{font:inherit;padding:9px 16px;margin:8px 0;border:1px solid #bdd2ce;border-radius:8px}button{background:#087e85;color:white;cursor:pointer}a{color:#087e85}small{color:#617477}section{border-top:1px solid #ddd;padding:16px 0}</style><main>${body}</main></html>`;
async function body(req: IncomingMessage): Promise<URLSearchParams> {
  let value = ''; for await (const part of req) { value += String(part); if (Buffer.byteLength(value) > 16384) throw new Error('Form too large'); }
  return new URLSearchParams(value);
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.openai.com; base-uri 'none'; frame-ancestors 'none'");
  if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { res.writeHead(403); res.end('Loopback only'); return; }
  const url = new URL(req.url ?? '/', origin);
  const page = (content: string, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(shell(content)); };
  const redirect = (to: string) => { res.writeHead(303, { location: to }); res.end(); };
  try {
    for (const [state, p] of pending) if (p.expiresAt < Date.now()) pending.delete(state);
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { page('请求来源不匹配。', 403); return; }
      const params = await body(req);
      if (params.get('csrf') !== csrf) { page('页面已过期，请刷新。', 403); return; }
      const clientId = params.get('clientId') ?? '';
      if (url.pathname === '/connect') {
        const store = readSubscriptionStore(); const account = clientId ? store.accounts.find(a => a.clientId === clientId) : undefined;
        if (clientId && !account) throw new Error('未知账号');
        const prepared = prepareSubscriptionLogin(store, origin + '/auth/callback', account);
        pending.set(prepared.pending.state, prepared.pending); redirect(prepared.url); return;
      }
      if (url.pathname === '/activate') { if (params.get('credits') !== 'disabled') throw new Error('请先在 ChatGPT 设置关闭额外付费积分，并勾选确认。'); await activateSubscription(clientId, params.get('model') ?? ''); redirect('/?connected=1'); return; }
      if (url.pathname === '/disconnect') {
        const revoked = await disconnectSubscription(clientId);
        page(`<h1>已断开本机连接</h1><p>${revoked ? '远端会话已撤销。' : '未能确认远端撤销，请在 ChatGPT 设置中断开北航拍案。'}后台已停止使用该账号。</p><a href="/">返回</a>`); return;
      }
      page('Not found', 404); return;
    }
    if (req.method !== 'GET') { page('Method not allowed', 405); return; }
    if (url.pathname === '/auth/callback') {
      const state = url.searchParams.get('state') ?? ''; const attempt = pending.get(state);
      if (!attempt) throw new Error('授权已过期，请重新连接。'); pending.delete(state);
      const account = await completeSubscriptionLogin(url.searchParams, attempt);
      redirect('/models?clientId=' + encodeURIComponent(account.clientId)); return;
    }
    if (url.pathname === '/models') {
      const clientId = url.searchParams.get('clientId') ?? '';
      const models = await subscriptionCatalog(clientId);
      const account = readSubscriptionStore().accounts.find(a => a.clientId === clientId);
      page(`<h1>选择整理模型</h1><p>已授权账号：${html(account?.email ?? '')}。以下为此账号当前可用的模型。</p>${models.length ? form('/activate', `<input type="hidden" name="clientId" value="${html(clientId)}"><select name="model">${models.map(m => `<option value="${html(m.slug)}">${html(m.display_name)} · ${html(m.slug)}</option>`).join('')}</select><br><label><input type="checkbox" name="credits" value="disabled" required> 我已关闭本应用使用额外付费积分的权限</label><br><button>使用此模型，开始自动整理</button>`) : '<p>账号没有返回可用模型，请在 ChatGPT 设置确认已允许本应用使用订阅。</p>'}<p><small>使用订阅额度，额度不足时等待；不自动转为付费 API。本机另设每天 100 次模型调用保护，包含重试与评测，不限制消息条数。请在 ChatGPT 中关闭本应用使用额外付费积分的权限。</small></p><a href="/">返回</a>`); return;
    }
    if (url.pathname !== '/') { page('Not found', 404); return; }
    const store = readSubscriptionStore();
    page(`<h1>北航拍案 · ChatGPT 连接</h1><p>通过 OpenAI 官方登录授权使用你的订阅额度。密码只输入 OpenAI 的页面。</p>${url.searchParams.has('connected') ? '<p><strong>已选择模型。后台可以开始整理；实际调用还需验证。</strong></p>' : ''}${form('/connect', '<button>Continue with ChatGPT</button>')}<p><small>授权和模型选择完成后，可以关闭这个页面。授权文件保存在本机数据卷中，不发送到对话或浏览器存储。</small></p>${store.accounts.map((a, i) => `<section><strong>账号 ${i + 1}：${html(a.email)}</strong><p>${a.clientId === store.activeClientId ? '当前使用' : '已保存'} · 模型 ${html(a.model ?? '尚未选择')}</p><a href="/models?clientId=${encodeURIComponent(a.clientId)}">选择模型 / 切换账号</a>${form('/connect', `<input type="hidden" name="clientId" value="${html(a.clientId)}"><button>重新授权</button>`)}${form('/disconnect', `<input type="hidden" name="clientId" value="${html(a.clientId)}"><button>断开此账号</button>`)}</section>`).join('')}<p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">管理 ChatGPT 订阅使用额度</a> · <a href="http://localhost:3000">返回北航拍案</a></p>`);
  } catch (error) {
    // Never echo provider bodies, authorization URLs, codes, ID tokens or access tokens.
    const diagnostic = subscriptionDiagnostic(error);
    console.warn(JSON.stringify({ event: 'chatgpt_connection_failed', path: url.pathname, code: diagnostic.code }));
    page(`<h1>连接暂未完成</h1><p>${html(diagnostic.text)}</p><p>错误代码：${html(diagnostic.code)}</p><a href="/">返回重试</a>`, 400);
  }
});
server.listen(port, '127.0.0.1', () => console.log('ChatGPT connection page: ' + origin));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { server.close(() => void closeDb().then(() => process.exit(0))); });
