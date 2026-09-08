const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const moduleUnderTest = { exports: {} };
class AppError extends Error {}
const dependencies = { './auth': {AppError}, './prisma': {}, './usage-ledger': {}, './usage-values': {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/lib/sso-tool-requests.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {module:moduleUnderTest,exports:moduleUnderTest.exports,require:k=>dependencies[k]||require(k)});
const {transitionRequest: transition, toolRequestSchema: schema} = moduleUnderTest.exports;
const input = {action:'reserve', product:'sabc', userId:'employee1', requestId:'813f777b-ab70-4e11-8a64-5ce05cf2e5ba',operation:'analysis',model:'test',providerId:'test'};
test('reserve, settle, release are idempotent and final state cannot be reversed',()=>{
 const reserved=transition(undefined,input);
 assert.equal(transition(reserved,input).status,'pending');
 const settled=transition(reserved,{...input,action:'settle'});
 assert.equal(transition(settled,{...input,action:'settle'}),settled);
 assert.equal(transition(settled,{...input,action:'release'}),settled);
 assert.throws(()=>transition(settled,input));
 const released=transition(reserved,{...input,action:'release'});
 assert.equal(transition(released,{...input,action:'release'}),released);
 assert.throws(()=>transition(released,{...input,action:'settle'}));
});
test('unreserved and cross-user/model requests fail',()=>{
 assert.throws(()=>transition(undefined,{...input,action:'settle'}));
 const reserved=transition(undefined,input);
 for(const key of ['userId','product','operation','model','providerId']) assert.throws(()=>transition(reserved,{...input,action:'settle',[key]:'other'}));
});
test('malformed usage is rejected and fixed media is accepted without fake tokens',()=>{
 assert.equal(schema.safeParse({...input,action:'settle'}).success,false);
 assert.equal(schema.safeParse({...input,action:'settle',usage:{inputTokens:1,outputTokens:2,totalTokens:1}}).success,false);
 assert.equal(schema.safeParse({...input,action:'settle',mediaProduct:'nanobanana2',billableUnits:1}).success,true);
 assert.equal(schema.safeParse({...input,action:'settle',usage:{inputTokens:1,outputTokens:2,totalTokens:3}}).success,true);
});
