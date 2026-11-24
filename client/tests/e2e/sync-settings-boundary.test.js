import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const harness=vi.hoisted(()=>({fixture:null}));
vi.mock('./sync-native-fixture.mjs',()=>({
  syncCase:async(_name,run)=>run(harness.fixture),
  assert:(value,message)=>{if(!value)throw Error(message);},
  until:vi.fn(),
}));
beforeEach(()=>vi.resetModules());
afterEach(()=>{harness.fixture=null;});

for(const afterEntry of [false,true])it(`propagates open rejection ${afterEntry?'after':'before'} instrumented entry and cleans up the held boundary`,async()=>{
  const error=Error('forced initial Settings evaluation rejection');
  let listener;
  const configUrl='http://globnotes.test/_/api/config';
  const frame={id:'main-frame',loaderId:'outgoing',url:'http://globnotes.test/'};
  const configRequest=(requestId,loaderId,frameId=frame.id)=>listener({method:'Network.requestWillBeSent',params:{requestId,loaderId,frameId,request:{method:'GET',url:configUrl}}});
  const configPause=(requestId,networkId,frameId=frame.id)=>listener({method:'Fetch.requestPaused',params:{requestId,networkId,frameId,request:{method:'GET',url:configUrl},responseStatusCode:200}});
  const stop=vi.fn(),poll=vi.fn(async()=>true),click=vi.fn();
  const session={poll,click,goto:vi.fn(async()=>{
    frame.loaderId='incoming';
    configRequest('child-wire',frame.loaderId,'child-frame');configPause('held-child','child-wire','child-frame');
    configPause('held-incoming','incoming-wire');configRequest('incoming-wire',frame.loaderId);
  }),page:{onEvent:vi.fn(callback=>{listener=callback;return stop;})},
    evaluate:vi.fn(async expression=>{
      if(expression==='forced initial Settings evaluation')throw error;
      if(expression.startsWith('({sidebar:'))return {sidebar:false,settings:false};
      return false;
    }),
    send:vi.fn(async method=>{
      if(method==='Page.getFrameTree')return {frameTree:{frame:{...frame}}};
      if(method==='Fetch.enable'){
        configRequest('outgoing-wire',frame.loaderId);configPause('held-outgoing','outgoing-wire');
      }
    }),
  };
  const fixture={session,remote:{put:vi.fn()},url:path=>`http://globnotes.test${path}`,results:[],capture:vi.fn(),
    signIn:vi.fn(async()=>{}),
    open:vi.fn(async()=>{
      if(afterEntry)await session.poll('forced sidebar owner wait');
      await session.evaluate('forced initial Settings evaluation');
    }),
  };
  harness.fixture=fixture;
  const failure=await import('./sync-settings-native.mjs').then(()=>null,cause=>cause);
  expect(failure).toBe(error);
  expect(fixture.signIn).toHaveBeenCalledOnce();
  expect(fixture.open).toHaveBeenCalledOnce();
  expect(session.poll).toBe(poll);expect(session.click).toBe(click);
  expect(stop).toHaveBeenCalledOnce();
  expect(session.send.mock.calls.filter(([method])=>method==='Fetch.disable')).toHaveLength(afterEntry?2:1);
  expect(session.send.mock.calls.filter(([method])=>method==='Fetch.continueRequest')).toEqual(afterEntry?[['Fetch.continueRequest',{requestId:'held-incoming'}]]:[]);
  expect(poll).toHaveBeenCalledTimes(afterEntry?1:0);expect(click).not.toHaveBeenCalled();
  expect(fixture.capture).not.toHaveBeenCalled();
});
