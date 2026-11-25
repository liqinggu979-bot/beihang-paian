// Official SIWC only. Credentials remain in the backend data volume, never browser storage.
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { config } from '../config.ts';
import { sql } from '../db.ts';
import { BudgetExceededError, ProviderRejectedError } from './receipts.ts';

export const SUBSCRIPTION_SERVICE = 'chatgpt_subscription';
export const SUBSCRIPTION_DAILY_LIMIT = config.chatgptDailyRequestLimit;
export const subscriptionMode = () => process.env.LLM_PROVIDER === 'chatgpt_subscription';
type JsonWebKey = { kty?: string; kid?: string; n?: string; e?: string; [key: string]: unknown };
const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const REQUIRED_SCOPES = ['chatgpt.tokens.use.direct', 'resource.invoke', 'offline_access'];
export interface Account {
  clientId: string; subject: string; email: string; accessToken: string; refreshToken: string;
  idToken: string; expiresAt: number; scopes: string[]; model?: string;
}
export interface Store { hostId: string; activeClientId?: string; accounts: Account[]; }
export interface PendingLogin { state: string; nonce: string; verifier: string; redirectUri: string; expiresAt: number; clientId?: string; subject?: string; }
export interface CatalogModel { slug: string; display_name: string; }
const file = () => path.join(config.dataDir, 'chatgpt', 'credentials.json');
export function saveSubscriptionStore(store: Store): void {
  mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file()), 0o700);
  const temp = file() + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(store), { mode: 0o600 });
  renameSync(temp, file());
  chmodSync(file(), 0o600);
}
export function readSubscriptionStore(): Store {
  if (existsSync(file())) return JSON.parse(readFileSync(file(), 'utf8')) as Store;
  return { hostId: 'urn:uuid:' + randomUUID(), accounts: [] };
}
export function subscriptionModel(): string { const s = readSubscriptionStore(); return s.accounts.find(a => a.clientId === s.activeClientId)?.model ?? ''; }
export function subscriptionReady(): boolean { const s = readSubscriptionStore(); return s.accounts.some(a => a.clientId === s.activeClientId && !!a.model && !!a.refreshToken); }

let proxy: ProxyAgent | undefined;
export async function subscriptionFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  if (![AUTH, 'https://api.openai.com'].includes(target.origin)) throw new Error('Unapproved ChatGPT authorization destination');
  const proxyUrl = config.chatgptProxyUrl || config.egressProxyUrl;
  if (proxyUrl) proxy ??= new ProxyAgent({ uri: proxyUrl, allowH2: false, requestTls: { timeout: 25_000 }, proxyTls: { timeout: 25_000 } });
  // Node's bundled fetch and this installed dispatcher use different Undici handler versions.
  return await undiciFetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000), ...(proxy ? { dispatcher: proxy } : {}) } as UndiciRequestInit) as unknown as Response;
}
export function prepareSubscriptionLogin(store: Store, redirectUri: string, account?: Account): { pending: PendingLogin; url: string } {
  const callback = new URL(redirectUri);
  if (callback.hostname !== '127.0.0.1' || callback.protocol !== 'http:' || callback.pathname !== '/auth/callback') throw new Error('SIWC requires an exact HTTP loopback callback');
  const pending: PendingLogin = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'), redirectUri, expiresAt: Date.now() + 10 * 60_000, clientId: account?.clientId, subject: account?.subject };
  const params = new URLSearchParams({ client_id: account?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: store.hostId,
    response_type: 'code', redirect_uri: redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE,
    state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') });
  if (!account) params.set('agent_name_hint', '北航拍案');
  // Login hints contain credentials: this URL must never be logged or copied into chat.
  if (account?.idToken) params.set('id_token_hint', account.idToken);
  return { pending, url: AUTH + '/api/accounts/authorize?' + params };
}
export function validateSubscriptionCallback(query: URLSearchParams, pending: PendingLogin): { code: string; clientId: string } {
  if (Date.now() > pending.expiresAt || query.get('state') !== pending.state) throw new Error('登录已过期或 state 不匹配，请重新连接。');
  if (query.get('error')) throw new Error('授权未完成，请重新连接并允许使用订阅额度。');
  const clientId = query.get('client_id') ?? pending.clientId;
  if (!clientId || clientId === 'dynamic_agent_client' || (pending.clientId && clientId !== pending.clientId)) throw new Error('授权客户端不匹配。');
  const code = query.get('code'); if (!code) throw new Error('授权回调缺少 code。');
  return { code, clientId };
}
export function validateSubscriptionIdToken(token: string, keys: JsonWebKey[], clientId: string, nonce: string, now = Date.now()): { subject: string; email: string } {
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('Invalid ID token');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  const jwk = keys.find(k => (k as JsonWebKey & { kid?: string }).kid === header.kid && k.kty === 'RSA');
  if (header.alg !== 'RS256' || !jwk || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'))) throw new Error('Invalid ID token signature');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== AUTH || !aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub || (claims.nbf && claims.nbf * 1000 > now + 30_000)) throw new Error('Invalid ID token claims');
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : 'ChatGPT 用户' };
}
export class SubscriptionUsageUnavailableError extends BudgetExceededError {
  constructor(seconds = 3600) { super(SUBSCRIPTION_SERVICE, 'subscription usage unavailable', seconds); }
}
const pauseKey = (clientId: string) => SUBSCRIPTION_SERVICE + '.pause.' + createHash('sha256').update(clientId).digest('hex');
export async function subscriptionPauseUntil(clientId = readSubscriptionStore().activeClientId): Promise<Date | null> {
  if (!clientId) return null;
  const [row] = await sql<{ value: { until?: string } }[]>`SELECT value FROM settings WHERE key = ${pauseKey(clientId)}`;
  const until = new Date(row?.value.until ?? '');
  return Number.isFinite(+until) && +until > Date.now() ? until : null;
}
export async function assertSubscriptionAvailable(clientId?: string): Promise<void> {
  const until = await subscriptionPauseUntil(clientId);
  if (until) throw new SubscriptionUsageUnavailableError(Math.max(1, Math.ceil((+until - Date.now()) / 1000)));
}
export async function pauseSubscription(seconds: number, clientId: string): Promise<void> {
  const until = new Date(Date.now() + Math.max(60, Math.min(86400, seconds)) * 1000).toISOString();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${pauseKey(clientId)}, ${sql.json({ until })}, 'subscription-provider')
    ON CONFLICT (key) DO UPDATE SET value = CASE WHEN settings.value->>'until' > EXCLUDED.value->>'until' THEN settings.value ELSE EXCLUDED.value END, updated_at = now(), updated_by = EXCLUDED.updated_by`;
}
function subscriptionRetrySeconds(value: string | null): number {
  const seconds = value && /^\d+$/.test(value) ? Number(value) : value ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(60, Math.min(86400, seconds)) : 3600;
}

export class SubscriptionAuthorizationError extends BudgetExceededError {
  readonly status: number;
  readonly diagnosticCode: string;
  constructor(status: number, code: string) {
    super(SUBSCRIPTION_SERVICE, 'authorization unavailable', 3600);
    this.status = status; this.diagnosticCode = code;
  }
}
export function subscriptionDiagnostic(error: unknown): { code: string; text: string } {
  if (error instanceof SubscriptionAuthorizationError) return { code: error.diagnosticCode, text: error.diagnosticCode === 'invalid_grant' ? '授权码失效，请重新开始官方授权。' : `官方令牌交换未成功（HTTP ${error.status}），请根据错误代码排查授权。` };
  const transport = (error as { cause?: { code?: string } })?.cause?.code;
  if (['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ABORT_ERR','ECONNREFUSED','ENOTFOUND','ECONNRESET'].includes(transport ?? '')) return {code:transport!,text:'后台连接官方授权服务超时或中断，请检查本机代理的连通性。'};
  if (transport === 'UND_ERR_INVALID_ARG') return {code:transport,text:'后台 HTTP 请求库配置不兼容，需要修复程序。'};
  const message = error instanceof Error ? error.message : '';
  const known: Record<string,string> = { 'Invalid ID token signature':'ID_TOKEN_SIGNATURE_INVALID', 'Invalid ID token claims':'ID_TOKEN_CLAIMS_INVALID', 'Invalid subscription credentials':'TOKEN_FIELDS_INVALID', 'Invalid ID token':'ID_TOKEN_INVALID', 'Returning ChatGPT account identity mismatch':'ACCOUNT_MISMATCH' };
  if (known[message]) return {code:known[message]!,text:'官方授权结果未通过身份或令牌校验，后台尚未连接账号。'};
  if (/[\u4e00-\u9fff]/.test(message)) return {code:'AUTHORIZATION_INCOMPLETE',text:message};
  return {code:'CONNECTION_INCOMPLETE',text:'连接暂未完成，请根据错误代码排查。'};
}
async function exchange(params: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await subscriptionFetch(AUTH + '/api/accounts/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    const code = typeof body?.error === 'string' && ['invalid_grant','invalid_client','access_denied','invalid_scope','unauthorized_client'].includes(body.error) ? body.error : 'TOKEN_HTTP_' + res.status;
    throw new SubscriptionAuthorizationError(res.status, code);
  }
  return await res.json() as Record<string, unknown>;
}
function grantedScopes(token: Record<string, unknown>, previous?: string[]): string[] {
  const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : previous ?? [];
  if (!REQUIRED_SCOPES.every(s => scopes.includes(s))) throw new Error('ChatGPT 订阅权限未授予。');
  return scopes;
}
function tokenExpiry(token: Record<string, unknown>): number {
  const expires = Number(token.expires_in);
  if (!Number.isFinite(expires) || expires <= 0 || expires > 86400 || String(token.token_type).toLowerCase() !== 'bearer' || typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('Invalid subscription credentials');
  return Date.now() + expires * 1000;
}
export async function completeSubscriptionLogin(query: URLSearchParams, pending: PendingLogin): Promise<Account> {
  const { code, clientId } = validateSubscriptionCallback(query, pending);
  const token = await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }));
  const jwks = await (await subscriptionFetch(AUTH + '/.well-known/jwks.json')).json() as { keys: JsonWebKey[] };
  const identity = validateSubscriptionIdToken(String(token.id_token), jwks.keys, clientId, pending.nonce);
  if (pending.subject && pending.subject !== identity.subject) throw new Error('Returning ChatGPT account identity mismatch');
  const account: Account = { clientId, ...identity, idToken: String(token.id_token), accessToken: String(token.access_token), refreshToken: String(token.refresh_token), expiresAt: tokenExpiry(token), scopes: grantedScopes(token) };
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('beihang:chatgpt-session'))`;
    const store = readSubscriptionStore();
    const old = store.accounts.find(a => a.clientId === clientId);
    account.model = old?.model;
    store.accounts = [...store.accounts.filter(a => a.clientId !== clientId), account];
    // A new account remains inactive until the user chooses one of its live catalog models.
    saveSubscriptionStore(store);
  });
  return account;
}
export async function subscriptionAccount(clientId?: string): Promise<Account> {
  // The rotating refresh token is shared across backend processes; serialize refresh + atomic storage.
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('beihang:chatgpt-session'))`;
    const store = readSubscriptionStore();
    const account = store.accounts.find(a => a.clientId === (clientId ?? store.activeClientId));
    if (!account) throw new BudgetExceededError(SUBSCRIPTION_SERVICE, 'sign-in required', 3600);
    if (account.expiresAt <= Date.now() + 60_000) {
      const token = await exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE }));
      account.expiresAt = tokenExpiry(token); account.scopes = grantedScopes(token, account.scopes);
      account.accessToken = String(token.access_token); account.refreshToken = String(token.refresh_token);
      if (typeof token.id_token === 'string') account.idToken = token.id_token;
      saveSubscriptionStore(store);
    }
    return { ...account };
  });
}
export async function subscriptionCatalog(clientId: string): Promise<CatalogModel[]> {
  const account = await subscriptionAccount(clientId);
  const res = await subscriptionFetch(RESOURCE + '/models', { headers: { authorization: 'Bearer ' + account.accessToken } });
  if (!res.ok) throw new Error('无法读取订阅模型列表，请检查授权或稍后重试。');
  const body = await res.json() as { models?: Array<CatalogModel & { visibility?: string }> };
  return (body.models ?? []).filter(m => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string');
}
export async function activateSubscription(clientId: string, model: string): Promise<void> {
  if (!(await subscriptionCatalog(clientId)).some(m => m.slug === model)) throw new Error('所选模型不在此账号可用列表中。');
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('beihang:chatgpt-session'))`;
    const store = readSubscriptionStore(); const account = store.accounts.find(a => a.clientId === clientId);
    if (!account) throw new Error('Account no longer connected');
    account.model = model; store.activeClientId = clientId; saveSubscriptionStore(store);
  });
}
export async function disconnectSubscription(clientId: string): Promise<boolean> {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('beihang:chatgpt-session'))`;
    const store = readSubscriptionStore(); const account = store.accounts.find(a => a.clientId === clientId);
    if (!account) return true;
    let revoked = false;
    try {
      const res = await subscriptionFetch(AUTH + '/api/accounts/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: account.clientId, token: account.refreshToken, token_type_hint: 'refresh_token' }).toString() });
      revoked = res.ok;
    } catch { /* Stop locally even when remote revocation cannot be confirmed. */ }
    store.accounts = store.accounts.filter(a => a.clientId !== clientId);
    if (store.activeClientId === clientId) delete store.activeClientId;
    saveSubscriptionStore(store); return revoked;
  });
}

export function subscriptionRequest(model: string, system: string, user: string): Record<string, unknown> {
  if (!model || Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8') > 24000) throw new Error('Subscription model/input bounds invalid');
  // SIWC does not accept temperature, max_output_tokens or background. Instructions request brevity.
  return { model, instructions: system, input: [{ role: 'user', content: user }], store: false, stream: true };
}
export async function consumeSubscriptionStream(res: Response): Promise<{ id?: string; content: string; usage: Record<string, unknown> | null }> {
  if (!res.ok) {
    if (res.status === 429) throw new SubscriptionUsageUnavailableError(subscriptionRetrySeconds(res.headers.get('retry-after')));
    if ([401,403].includes(res.status)) throw new BudgetExceededError(SUBSCRIPTION_SERVICE, 'reauthorization required', 3600);
    throw new ProviderRejectedError('ChatGPT subscription HTTP ' + res.status, res.status, res.status >= 500);
  }
  if (!res.body) throw new Error('Subscription response has no stream');
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let bytes = 0;
  // The subscription endpoint streams text separately; its terminal output can be empty.
  const parts = new Map<string, { output: number; content: number; text: string }>();
  const setPart = (output: number, content: number, text: string, append = false) => {
    const key = output + ':' + content;
    parts.set(key, { output, content, text: append ? (parts.get(key)?.text ?? '') + text : text });
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 4 * 1024 * 1024) throw new Error('Subscription stream exceeds response bound');
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as { type: string; output_index?: number; content_index?: number; delta?: string; text?: string; part?: { type: string; text?: string }; item?: { type: string; content?: Array<{ type: string; text?: string }> }; response?: { id?: string; output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; usage?: Record<string, unknown>; error?: { code?: string } }; error?: { code?: string } };
        if (event.type === 'response.failed' || event.type === 'error') {
          const code = event.response?.error?.code ?? event.error?.code;
          if (code?.startsWith('subscription_sharing_usage_')) throw new SubscriptionUsageUnavailableError();
          throw new Error('Subscription inference failed');
        }
        if (event.type === 'response.incomplete') throw new Error('Subscription inference incomplete');
        const output = event.output_index ?? 0; const contentIndex = event.content_index ?? 0;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') setPart(output, contentIndex, event.delta, true);
        if (event.type === 'response.output_text.done' && typeof event.text === 'string') setPart(output, contentIndex, event.text);
        if (event.type === 'response.content_part.done' && event.part?.type === 'output_text' && typeof event.part.text === 'string') setPart(output, contentIndex, event.part.text);
        if (event.type === 'response.output_item.done' && event.item?.type === 'message') event.item.content?.forEach((c, i) => {
          if (c.type === 'output_text' && typeof c.text === 'string') setPart(output, i, c.text);
        });
        if (event.type === 'response.completed') {
          const response = event.response;
          const content = response?.output?.filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text ?? '').join('') || [...parts.values()].sort((a, b) => a.output - b.output || a.content - b.content).map(p => p.text).join('');
          if (!content) throw new Error('Completed subscription response has no text');
          return { id: response?.id, content, usage: response?.usage ?? null };
        }
      }
    }
    throw new Error('Subscription stream interrupted before response.completed');
  } finally { await reader.cancel().catch(() => {}); }
}
