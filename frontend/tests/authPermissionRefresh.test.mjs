import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTsModule.mjs';

test('cached admin or model grants stay hidden until server verification, including failures', async () => {
  const oldWindow=globalThis.window, oldStorage=globalThis.localStorage;
  const storage=new Map([['token','test-token'],['user',JSON.stringify({id:'member',role:'admin',modelAccess:{sites:[]}})]]);
  globalThis.window={};globalThis.localStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  let state,resolve,reject;
  try {
    await loadTsModule(new URL('../app/stores/auth.ts',import.meta.url),{
      zustand:{create:init=>{state=init(update=>{state={...state,...(typeof update==='function'?update(state):update)}});return ()=>state}},
      '../lib/api':{api:{getMe:()=>new Promise((ok,fail)=>{resolve=ok;reject=fail})}},
      '../lib/local-data-migration':{runLocalDataMigration:async()=>{}},
    });
    assert.equal(state.user,null);assert.equal(state.isLoading,true);
    const loading=state.loadUser();assert.equal(state.user,null);
    resolve({data:{id:'member',role:'member',modelAccess:{sites:[]}}});await loading;
    assert.equal(state.user.role,'member');assert.equal(state.isLoading,false);
    const retry=state.loadUser();assert.equal(state.user,null);reject(Error('expired'));await retry;
    assert.equal(state.user,null);assert.equal(state.token,null);assert.equal(state.isAuthenticated,false);
  } finally {globalThis.window=oldWindow;globalThis.localStorage=oldStorage;}
});
