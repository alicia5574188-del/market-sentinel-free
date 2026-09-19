import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {initialForward,forwardSummary} from '../lib/forward-relations.ts';
const folder='.live-ui-browser',out=process.env.UI_RESULTS||'/tmp/live-ui-results';
await mkdir(folder,{recursive:true});await mkdir(out,{recursive:true});
await writeFile(`${folder}/index.html`,'<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/.live-ui-browser/entry.tsx"></script></body></html>');
await writeFile(`${folder}/entry.tsx`,'import React from "react";import{createRoot}from"react-dom/client";import Home from "../app/page.tsx";import"../app/globals.css";import"../app/forward-dashboard.css";import"../app/member-access.css";import"../app/record-controls.css";import"../app/equity-curve.css";import"../app/live-priority.css";createRoot(document.getElementById("root")!).render(<Home/>);');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:19090,strictPort:true}});await server.listen();
const browser=await chromium.launch({headless:true});const results=[];
try{
 for(const role of ['owner','member'])for(const width of [320,393,768,1440]){
  const context=await browser.newContext({viewport:{width,height:width<400?852:1024},isMobile:width<400,hasTouch:width<400});
  const page=await context.newPage(),errors=[],writes=[];page.on('pageerror',e=>errors.push(String(e)));
  const now=Date.now(),state=initialForward(now-86400000);state.storage={persistedAt:now,error:null};
  const positions=Object.fromEntries(['BTC_USDT','ETH_USDT','SOL_USDT','HYPE_USDT'].map((symbol,i)=>[symbol,{id:`ft-fixture-${i}`,symbol,side:i%2?'SHORT':'LONG',scenario:'SOURCE_MIRROR',status:'OPEN',entryAt:now-600000,entryPrice:100,initialStop:99,currentStop:99,currentTarget:102,notional:100,plannedRisk:1,leverage:2,margin:50,exchangeSize:.1,exchangeUnrealisedPnl:i?.5:-1.5,exchangePnlMargin:50,exchangePnlAt:now,exchangePnlMarginSource:'margin',exchangeMarkPrice:100,stopOrderId:String(i+1),exchangeUpdatedAt:now}]));
  const data={state:'LIVE',stale:false,authorityReady:true,lastSuccessAt:now,generatedAt:now,forward:forwardSummary(state,{},now),liveMode:{requestedEnabled:true,operational:true},live:{requestedEnabled:true,operational:true,lastSyncAt:now,lastError:null,equity:908.44,available:669.51,positions,entries:{},history:[],entrySkips:{},auditEvents:[],mirror:{connected:true,sourceCount:9,copiedCount:4,eligibleSourceCount:4,eligibleCopiedCount:4,eligibleMissingCount:0,excludedSourceCount:5,pendingCount:0,minimumSizeBlockedCount:0,managedBeforeEnableCount:0,enabledAt:now-3600000,rows:Array.from({length:9},(_,i)=>({sourceId:`excluded-${i}`,symbol:`OLD_${i}_USDT`,status:'EXCLUDED',reason:'开启前或本次接入前已有的模拟持仓，不补开'}))}}};
  const auth={configured:true,authenticated:true,username:role==='owner'?'owner':'会员甲',role,...(role==='member'?{memberId:'m_'+'a'.repeat(32)}:{})};
  await page.route('**/api/**',async route=>{const r=route.request(),p=new URL(r.url()).pathname;let value={},status=200;
   if(r.method()!=='GET'){writes.push(p);throw new Error('Unexpected mutation '+p);}
   if(p==='/api/auth/session')value=auth;else if(p==='/api/runtime')value=data;
   else if(p==='/api/live/credentials')value={credential:{configured:true,keyHint:'fixture-only',status:'verified'}};
   else if(p==='/api/live/history')value={history:[],pending:0};
   else if(p==='/api/forward/equity'){status=503;value={error:'Synthetic chart deliberately unavailable'};}
   else if(p==='/api/members/admin')value={members:[],memberLimit:20,activeLimit:2,activeCount:0,current:null};
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.goto('http://127.0.0.1:19090/.live-ui-browser/index.html');
  const liveButton=page.locator('.fr-nav button').filter({hasText:'实盘'});await liveButton.click();
  const equity=page.getByTestId('live-equity-first'),holdings=page.getByTestId('live-holdings-first'),details=page.getByTestId('live-copy-details');
  await page.waitForFunction(()=>document.querySelector('[data-testid="live-equity-first"]')?.textContent.includes('908.44'));
  await page.waitForTimeout(1100);await page.screenshot({path:`${out}/${role}-${width}.png`,fullPage:false});
  assert.equal(await page.locator('.fr-position-row').count(),4);assert.equal(await details.getAttribute('open'),null);
  const e=await equity.boundingBox(),h=await holdings.boundingBox(),n=await page.locator('.fr-nav').boundingBox();
  assert.ok(e.y+e.height<n.y,`equity fold ${role} ${width}: ${JSON.stringify({e,h,n})}`);
  assert.ok(h.y+90<n.y,`holdings fold ${role} ${width}: ${JSON.stringify({e,h,n})}`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`horizontal overflow ${role} ${width}`);
  await page.locator('.fr-position-row').first().locator('summary').click();assert.notEqual(await page.locator('.fr-position-row').first().getAttribute('open'),null);
  await details.locator('summary').click();assert.match(await details.innerText(),/不补开/);
  for(const title of ['持仓','记录','归档','日志','API','账户'])await page.getByRole('navigation',{name:'实盘子导航'}).getByRole('button',{name:title,exact:true}).click();
  await page.evaluate(()=>scrollTo(0,700));await page.locator('.fr-nav button').filter({hasText:'总览'}).click();await liveButton.click();
  await page.waitForFunction(()=>scrollY<10);assert.equal(await details.getAttribute('open'),null);
  assert.equal(writes.length,0);assert.deepEqual(errors,[]);
  results.push({role,width,equityAboveFold:true,holdingsAboveFold:true,defaultCollapsedCopyDetails:true,allSixTabsAccessible:true,reentryAtTop:true,mutations:writes.length,pageErrors:errors});
  await context.close();
 }
 await writeFile(`${out}/browser.json`,JSON.stringify({testedSource:process.env.UI_SOURCE_SHA,syntheticAccountsOnly:true,actualHomeReactAndCss:true,results},null,2));console.log(JSON.stringify({browserCases:results.length,syntheticAccountsOnly:true}));
}finally{await browser.close();await server.close();await rm(folder,{recursive:true,force:true});}
