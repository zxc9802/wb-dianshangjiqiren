const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function setup() {
    let row = { id: 'ticket', product: 'sabc', userId: 'u1', expiresAt: new Date(Date.now()+60000), usedAt: null, redirectPath: '/' };
    let user = { id: 'u1', email: 'employee', nickname: 'Employee', role: 'member', accessGrantedAt: new Date(), isActive: true, authTokenVersion: 2 };
    let denied = false;
    class AppError extends Error { constructor(message, status, code) { super(message); this.code=code; } }
    const tx = { user: { findUnique: async () => user }, videoSsoTicket: {
        findUnique: async () => ({...row}),
        updateMany: async () => { if(row.usedAt) return {count:0}; row.usedAt=new Date(); return {count:1}; },
    }};
    const dependencies = {
        './auth': { AppError, assertMemberAccountEnabled: u => { if(!u.isActive) throw new Error('disabled'); } },
        './server-bot-access': { assertUserCanAccessOfficialBot: async () => { if(denied) throw new Error('denied'); } },
        './prisma': { prisma: { $transaction: callback => callback(tx) } },
        './server-env': { readRequiredServerEnv: key => key.endsWith('APP_URL')?'https://tool.example':'test-secret' },
        './video-sso': { ensureVideoSsoTicketTable: async () => {} },
    };
    const module={exports:{}};
    const source=ts.transpileModule(fs.readFileSync('app/lib/external-sso.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    vm.runInNewContext(source,{module,exports:module.exports,require:key=>dependencies[key]||require(key),Buffer,URL,Date});
    return {api:module.exports,row,user,deny:()=>denied=true};
}
test('tool allowlist, fixed callback and redirect validation',()=>{
    const {api}=setup();assert.throws(()=>api.parseExternalSsoProduct('unknown'));
    assert.equal(api.buildExternalSsoCallbackUrl('sabc','a&b'),'https://tool.example/api/sso/callback?ticket=a%26b');
    for(const path of ['//evil.example','/\\evil.example','/\nevil','https://evil.example']) assert.equal(api.parseExternalSsoRedirectPath(path),null);
    assert.equal(api.parseExternalSsoRedirectPath('/records?tab=1'),'/records?tab=1');
    assert.equal(api.isValidExternalSsoClientSecret('sabc','wrong'),false);
    assert.equal(api.isValidExternalSsoClientSecret('sabc','test-secret'),true);
});
test('tickets are bound to product, expiring and single-use even concurrently',async()=>{
    let {api}=setup();await assert.rejects(api.consumeExternalSsoTicket('xiaoshou','ticket'));
    let s=setup();s.row.expiresAt=new Date(0);await assert.rejects(s.api.consumeExternalSsoTicket('sabc','ticket'));
    s=setup();const results=await Promise.allSettled([s.api.consumeExternalSsoTicket('sabc','ticket'),s.api.consumeExternalSsoTicket('sabc','ticket')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('disabled accounts and revoked tool permissions cannot exchange tickets',async()=>{
    let s=setup();s.user.isActive=false;await assert.rejects(s.api.consumeExternalSsoTicket('sabc','ticket'),/disabled/);assert.equal(s.row.usedAt,null);
    s=setup();s.deny();await assert.rejects(s.api.consumeExternalSsoTicket('sabc','ticket'),/denied/);assert.equal(s.row.usedAt,null);
});
