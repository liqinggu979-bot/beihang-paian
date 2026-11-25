import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { config, parseSubscriptionRequestLimit } from '@aihot/backend/config';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { z } from 'zod';
import { chatJson } from '@aihot/backend/providers/llm';
import { loadChecks } from '@aihot/backend/publication/checks';
import { SubscriptionUsageUnavailableError, assertSubscriptionAvailable, pauseSubscription, subscriptionPauseUntil, readSubscriptionStore, saveSubscriptionStore, subscriptionDiagnostic, subscriptionFetch, prepareSubscriptionLogin, validateSubscriptionCallback, validateSubscriptionIdToken, subscriptionRequest, consumeSubscriptionStream } from '@aihot/backend/providers/chatgpt-subscription';
import { BudgetExceededError, paidRequest } from '@aihot/backend/providers/receipts';

const store = { hostId: 'urn:uuid:15f8821d-0ef6-4c4b-91c4-bce43ba9e0f8', accounts: [] };
test('SIWC uses dynamic registration, required scopes, PKCE and exact loopback callback', () => {
 const a = prepareSubscriptionLogin(store, 'http://127.0.0.1:1456/auth/callback');
 const b = prepareSubscriptionLogin(store, 'http://127.0.0.1:1456/auth/callback');
 const q = new URL(a.url).searchParams;
 assert.equal(q.get('client_id'),'dynamic_agent_client'); assert.equal(q.get('ext_agent_host_id'),store.hostId);
 assert.match(q.get('scope')!, /chatgpt.tokens.use.direct/); assert.equal(q.get('code_challenge_method'),'S256');
 assert.notEqual(a.pending.state,b.pending.state); assert.notEqual(a.pending.nonce,b.pending.nonce);
 assert.throws(()=>prepareSubscriptionLogin(store,'http://localhost:1456/auth/callback'));
 const query = new URLSearchParams({state:a.pending.state,code:'one-use-code',client_id:'oaiapp_test'});
 assert.equal(validateSubscriptionCallback(query,a.pending).clientId,'oaiapp_test');
 query.set('state','forged'); assert.throws(()=>validateSubscriptionCallback(query,a.pending));
 query.set('state',a.pending.state); query.set('client_id','different');
 assert.throws(()=>validateSubscriptionCallback(query,{...a.pending,clientId:'original'}));
 assert.throws(()=>validateSubscriptionCallback(query,{...a.pending,expiresAt:0}));
});
test('ID token checks signature, issuer, client audience, nonce, expiry and selected identity', () => {
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'test'};
 const now=Date.now();
 const jwt=(changes={})=>{
  const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url');
  const p=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',aud:'oaiapp_test',exp:Math.floor(now/1000)+60,sub:'subject',nonce:'nonce',email:'test@example.invalid',...changes})).toString('base64url');
  return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');
 };
 assert.equal(validateSubscriptionIdToken(jwt(),[jwk],'oaiapp_test','nonce',now).subject,'subject');
 for(const changes of [{iss:'https://attacker.invalid'},{aud:'other'},{nonce:'wrong'},{exp:1},{aud:['oaiapp_test','other'],azp:'other'}]) assert.throws(()=>validateSubscriptionIdToken(jwt(changes),[jwk],'oaiapp_test','nonce',now));
 const bad=jwt().split('.');bad[1]=Buffer.from(JSON.stringify({sub:'attacker'})).toString('base64url');
 assert.throws(()=>validateSubscriptionIdToken(bad.join('.'),[jwk],'oaiapp_test','nonce',now));
});
const sse=(events:unknown[])=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
test('subscription request uses supported Responses fields only, and never paid API fallbacks',()=>{
 const body=subscriptionRequest('account-model','instructions','source');
 assert.deepEqual(Object.keys(body).sort(),['model','instructions','input','store','stream'].sort());
 assert.equal(body.store,false);assert.equal(body.stream,true);
 assert.throws(()=>subscriptionRequest('model','', '中'.repeat(9000)));
});
test('only completed SSE is accepted; partial deltas, interrupted streams and late quota errors stay pending',async()=>{
 const complete={type:'response.completed',response:{id:'response-1',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:10,output_tokens:5}}};
 const result=await consumeSubscriptionStream(sse([{type:'response.output_text.delta',delta:'wrong partial'},complete]));
 assert.equal(result.content,'{"ok":true}');assert.equal(result.id,'response-1');
 const bytes=new TextEncoder().encode('data: '+JSON.stringify(complete)+'\r\n\r\n');
 const fragmented=new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}});
 assert.equal((await consumeSubscriptionStream(new Response(fragmented))).content,'{"ok":true}');
 await assert.rejects(consumeSubscriptionStream(sse([{type:'response.output_text.delta',delta:'{"ok":true}'}])),/interrupted/);
 const terminal={type:'response.completed',response:{id:'subscription-result',output:[]}};
 const parts=[
  {type:'response.output_text.delta',output_index:1,content_index:0,delta:'true}'},
  {type:'response.output_text.delta',output_index:0,content_index:0,delta:'{"ok":'},
  {type:'response.output_text.done',output_index:0,content_index:0,text:'{"ok":'},
  {type:'response.content_part.done',output_index:1,content_index:0,part:{type:'output_text',text:'true}'}},
  {type:'response.output_item.done',output_index:1,item:{type:'message',content:[{type:'output_text',text:'true}'}]}},
 ];
 assert.equal((await consumeSubscriptionStream(sse([...parts,terminal]))).content,'{"ok":true}');
 await assert.rejects(consumeSubscriptionStream(sse(parts)),/interrupted/);
 await assert.rejects(consumeSubscriptionStream(sse([terminal])),/no text/);
 await assert.rejects(consumeSubscriptionStream(sse([{type:'response.incomplete'}])),/incomplete/);
 await assert.rejects(consumeSubscriptionStream(sse([{type:'response.output_text.delta',delta:'partial'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),BudgetExceededError);
 for(const status of [401,403,429]) await assert.rejects(consumeSubscriptionStream(new Response('',{status})),BudgetExceededError);
});

test('production subscription mode rejects paid API and unbounded subscription requests before dispatch', async()=>{
 const previousMode=process.env.LLM_PROVIDER; const previousEnv=process.env.NODE_ENV;
 process.env.LLM_PROVIDER='chatgpt_subscription';process.env.NODE_ENV='production';
 let dispatched=false;
 try {
  for(const request of [
   {service:'llm',dailyLimit:13},
   {service:'chatgpt_subscription',dailyLimit:config.chatgptDailyRequestLimit},
   {service:'chatgpt_subscription',billing:'subscription' as const,dailyLimit:config.chatgptDailyRequestLimit+1},
  ]) await assert.rejects(paidRequest({...request,purpose:'guard-test',identity:'test'},async()=>{dispatched=true;return {response:{}};}),BudgetExceededError);
  assert.equal(dispatched,false);
 } finally {
  if(previousMode===undefined)delete process.env.LLM_PROVIDER;else process.env.LLM_PROVIDER=previousMode;
  if(previousEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousEnv;
 }
});

test('official subscription fetch uses a dispatcher compatible with the installed HTTP library', async()=>{
 const previous=getGlobalDispatcher();const previousProxy=config.chatgptProxyUrl;const previousEgress=config.egressProxyUrl;
 const mock=new MockAgent();mock.disableNetConnect();
 mock.get('https://auth.openai.com').intercept({path:'/.well-known/openid-configuration',method:'GET'}).reply(200,{issuer:'https://auth.openai.com'});
 config.chatgptProxyUrl=null;config.egressProxyUrl=null;setGlobalDispatcher(mock);
 try {
  const response=await subscriptionFetch('https://auth.openai.com/.well-known/openid-configuration');
  assert.equal(response.status,200);assert.equal((await response.json() as {issuer:string}).issuer,'https://auth.openai.com');
  await assert.rejects(subscriptionFetch('https://attacker.invalid/'),/Unapproved/);
  mock.assertNoPendingInterceptors();
 } finally {setGlobalDispatcher(previous);config.chatgptProxyUrl=previousProxy;config.egressProxyUrl=previousEgress;await mock.close();}
});

test('connection diagnostics distinguish network and library errors without exposing credentials',()=>{
 const library=new TypeError('fetch failed',{cause:{code:'UND_ERR_INVALID_ARG'}});
 assert.equal(subscriptionDiagnostic(library).code,'UND_ERR_INVALID_ARG');
 const network=new TypeError('fetch failed',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
 assert.equal(subscriptionDiagnostic(network).code,'UND_ERR_CONNECT_TIMEOUT');
 assert.ok(!JSON.stringify(subscriptionDiagnostic(new Error('secret access_token=never-print'))).includes('never-print'));
 assert.equal(subscriptionDiagnostic(new Error('Invalid ID token claims')).code,'ID_TOKEN_CLAIMS_INVALID');
});


after(async()=>{await closeDb();});
test('subscription quota waits honour Retry-After without accepting partial results',async()=>{
 await assert.rejects(consumeSubscriptionStream(new Response('',{status:429,headers:{'retry-after':'90'}})),e=>e instanceof SubscriptionUsageUnavailableError && e.retryAfterSeconds===90);
 await assert.rejects(consumeSubscriptionStream(new Response('',{status:429,headers:{'retry-after':'invalid'}})),e=>e instanceof SubscriptionUsageUnavailableError && e.retryAfterSeconds===3600);
});
test('subscription pause persists across calls, blocks the entire account before dispatch and expires',async()=>{
 const client='pause-regression-account';
 const previous=readSubscriptionStore();const previousMode=process.env.LLM_PROVIDER;const enabled=config.modelCallsEnabled;
 saveSubscriptionStore({...previous,activeClientId:client});process.env.LLM_PROVIDER='chatgpt_subscription';config.modelCallsEnabled=true;
 try{
  await pauseSubscription(3600,client);const first=await subscriptionPauseUntil(client);
  assert.ok(first);await pauseSubscription(60,client);assert.equal(+(await subscriptionPauseUntil(client))!,+first);
  await assertSubscriptionAvailable('other-account');
  await assert.rejects(chatJson({model:'default',purpose:'pause-test',subject:'pause',promptVersion:'v1',system:'',user:'test',schema:z.object({ok:z.boolean()})}),SubscriptionUsageUnavailableError);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='pause-test'`)[0]!.n,0);
  const checks=await loadChecks();assert.equal(checks.budgetPaused,true);assert.equal(checks.modelResumeAt,first.toISOString());
  await sql`UPDATE settings SET value=jsonb_set(value,'{until}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE updated_by='subscription-provider'`;
  assert.equal(await subscriptionPauseUntil(client),null);await assertSubscriptionAvailable(client);
 }finally{
  saveSubscriptionStore(previous);config.modelCallsEnabled=enabled;
  if(previousMode===undefined)delete process.env.LLM_PROVIDER;else process.env.LLM_PROVIDER=previousMode;
 }
});

test('subscription request limit supports an explicit increase and refuses unlimited or malformed values',()=>{
 assert.equal(parseSubscriptionRequestLimit(undefined),100);assert.equal(parseSubscriptionRequestLimit(''),100);
 assert.equal(parseSubscriptionRequestLimit('200'),200);assert.equal(parseSubscriptionRequestLimit('1000'),1000);
 for(const value of ['0','-1','200requests','2.5','Infinity','1001','999999999999999999999'])assert.throws(()=>parseSubscriptionRequestLimit(value));
});

test('production honours a raised subscription guard and still refuses callers to bypass it',async()=>{
 const limit=config.chatgptDailyRequestLimit;const previousMode=process.env.LLM_PROVIDER;const previousEnv=process.env.NODE_ENV;
 config.chatgptDailyRequestLimit=200;process.env.LLM_PROVIDER='chatgpt_subscription';process.env.NODE_ENV='production';
 let calls=0;
 const request={service:'chatgpt_subscription',billing:'subscription' as const,purpose:'configured-limit-test',identity:'configured-limit-test',dailyLimit:200};
 try{
  for(const invalid of [100,201,undefined])await assert.rejects(paidRequest({...request,dailyLimit:invalid},async()=>{calls++;return {response:{ok:true}};}),BudgetExceededError);
  const receipt=await paidRequest(request,async()=>{calls++;return {response:{ok:true}};});
  assert.equal(calls,1);assert.deepEqual(receipt.response,{ok:true});
 }finally{
  config.chatgptDailyRequestLimit=limit;
  if(previousMode===undefined)delete process.env.LLM_PROVIDER;else process.env.LLM_PROVIDER=previousMode;
  if(previousEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousEnv;
 }
});
