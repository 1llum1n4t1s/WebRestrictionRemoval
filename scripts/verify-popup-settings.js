"use strict";
/* global window, document, Event, SettingsBackup */
// 未使用の絶対パス VUORA_BROWSER_TEST_DIR に専用プロファイルと確認画像を作る。
// 外部通信は遮断し、同梱popup全体のstorage/runtime境界だけをmockする。
const {test}=require("node:test");
const output=process.env.VUORA_BROWSER_TEST_DIR;
const puppeteer=require("puppeteer");
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,"..");
const messages=JSON.parse(fs.readFileSync(root+'/_locales/en/messages.json','utf8'));
const server=http.createServer((request,response)=>{
 const file=path.join(root,new URL(request.url,'http://localhost').pathname);
 try {
  assert.ok(file.startsWith(root+path.sep));
  response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
  response.end(fs.readFileSync(file));
 } catch {response.statusCode=404;response.end();}
});
test("popup: 履歴通知・保存失敗・同時操作", {timeout:60000}, async(t)=>{
 assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output), "未使用の絶対パスが必要です");
 for(let parent=path.dirname(output);;) {
  assert.equal(fs.lstatSync(parent).isSymbolicLink(),false);
  const next=path.dirname(parent); if(next===parent)break; parent=next;
 }
 fs.accessSync(path.dirname(output),fs.constants.W_OK); fs.mkdirSync(output);
 process.env.TEMP=output; process.env.TMP=output;
 t.after(()=>server.close());
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await puppeteer.launch({headless:true,userDataDir:path.join(output,"profile"),args:['--no-first-run','--disable-sync']});
 try {
 const page=await browser.newPage(); const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:500,height:900});
 await page.evaluateOnNewDocument((messages)=>{
 const listeners=[];window.saved={colorPickerHistory:[{hex:'#123456',ts:8640000000000001}],popupLastTab:'picker'};
 window.pending=[];window.delayedReads=[];
 window.closeCount=0;window.close=()=>{window.closeCount++;};
 window.emit=(patch)=>{
  const changes={};
  for(const [key,value]of Object.entries(patch)){
   changes[key]={oldValue:window.saved[key],newValue:value};window.saved[key]=value;
  }
  for(const notify of listeners)notify(changes,'local');
 };
 window.finish=(index,kind='fail',patch)=>{
  const pending=window.pending[index];
  if(patch)window.emit(patch);
  if(kind==='throw')pending.reject(new Error('mock failure'));
  else pending.resolve(kind==='ok'?{ok:true}:{ok:false,error:kind});
 };
 const event={addListener:f=>listeners.push(f),removeListener:()=>{}};
 window.chrome={
  i18n:{getUILanguage:()=> 'en',getMessage:(key,substitutions=[])=>{
   let text=messages[key]?.message||key;
   for(const [name,placeholder]of Object.entries(messages[key]?.placeholders||{}))
    text=text.replaceAll(new RegExp("\\$"+name+"\\$","gi"),()=>placeholder.content);
   for(const [index,value]of [].concat(substitutions).entries())text=text.replaceAll('$'+(index+1),()=>value);
   return text;
  }},
  storage:{onChanged:event,local:{
   get:async keys=>{
    const selected=Array.isArray(keys)?keys:Object.keys(window.saved);
    const snapshot=Object.fromEntries(selected.map(key=>[key,window.saved[key]]));
    if(window.holdSettingsRead && selected.includes('videoGammaEnabled'))
     await new Promise(resolve=>window.delayedReads.push(resolve));
    return snapshot;
   },
   set:async patch=>window.emit(patch),
  },sync:{get:async()=>({})}},
  runtime:{getManifest:()=>({version:'1.0.0'}),getURL:p=>window.location.origin+'/'+p,
   onMessage:{addListener:()=>{}},sendMessage:async message=>{
    if(message.action==='applySettings')return new Promise((resolve,reject)=>window.pending.push({message,resolve,reject}));
    if(message.action==='UPDATE_COLOR_HISTORY'){
     const history=[{hex:message.hex,ts:message.ts},...window.saved.colorPickerHistory.filter(entry=>entry.hex!==message.hex)];
     window.emit({colorPickerHistory:history});return {ok:true,history};
    }
    return {ok:true};
   }},
  tabs:{query:async()=>[]},
 };
 },messages);
 await page.setRequestInterception(true);
 page.on('request',r=>r.url().startsWith('http://127.0.0.1:')?r.continue():r.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}/src/popup/popup.html`);
 await page.waitForSelector('.history-chip');
 const check=async(fn,...args)=>page.evaluate(fn,...args);
 assert.equal(await check(()=>[document.querySelector('#specimenTime').textContent,
  document.querySelector('.history-chip').title].some(text=>text.includes('NaN'))),false);
 assert.equal(await check(()=>document.querySelector('#specimenTime').textContent),'—');
 // 旧backupの範囲外日時を失わず新しい色を保存・exportし、再選択しても時刻を捏造しない。
 await page.focus('[data-fmt-input="hex"]');
 await page.$eval('[data-fmt-input="hex"]',input=>{input.value='#abcdef';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.saved.colorPickerHistory.length===2);
 assert.equal(await check(()=>SettingsBackup.parse(SettingsBackup.stringify(window.saved,'test')).colorPickerHistory[1].ts),8640000000000001);
 await page.click('.history-chip[data-hex="#123456"]');
 assert.equal(await check(()=>document.querySelector('#specimenTime').textContent),'—');
 console.log('PASS legacy out-of-Date timestamp roundtrip after new color save; history click keeps unknown time');
 // 別popupの履歴更新が入力中の値・選択位置・パレットを壊さない。
 await check(()=>{const i=document.querySelector('[data-fmt-input="hex"]');i.focus();i.value='1234';i.dispatchEvent(new Event('input',{bubbles:true}));i.setSelectionRange(1,3);window.paletteBefore=document.querySelector('#paletteHue').value;window.emit({colorPickerHistory:[{hex:'#abcdef',ts:1234},{hex:'#123456',ts:2345}]});});
 assert.match(await check(()=>document.querySelector('#specimenNo').textContent),/02/);
 assert.deepEqual(await check(()=>{const i=document.querySelector('[data-fmt-input="hex"]');return [i.value,i.selectionStart,i.selectionEnd,document.querySelector('#paletteHue').value===window.paletteBefore];}),['1234',1,3,true]);
 await check(()=>window.emit({colorPickerHistory:[]}));
 assert.match(await check(()=>document.querySelector('#specimenNo').textContent),/Not saved/i);
 console.log('PASS history reorder/clear preserves edit, selection, palette; invalid stored time safe');
 await page.screenshot({path:path.join(output,"picker.png")});
 await page.click('#categoryTrigger'); await page.click('#tabTune');
 await check(()=>[...document.querySelectorAll('.cat-subtab')].find(button=>button.textContent.trim()==='Amazon').click());
 const toggle=async(id)=>page.click(`label:has(#${id}) .switch-track`);
 const settled=async()=>page.waitForFunction(()=>document.querySelector('#statusMsg').classList.contains('error'));
 await toggle('amazonDeliveryToggle');await check(()=>window.finish(0,'fail'));await settled();
 assert.equal(await check(()=>document.querySelector('#amazonDeliveryToggle').checked),false);
 await toggle('amazonDeliveryToggle'); await toggle('amazonRankingJumpToggle');
 await check(()=>{window.finish(2,'ok',{amazonRankingJumpEnabled:true});window.finish(1,'throw');});
 await page.waitForFunction(()=>!document.querySelector('#amazonDeliveryToggle').checked);
 assert.equal(await check(()=>document.querySelector('#amazonRankingJumpToggle').checked),true);
 // 同項目の古い失敗は、新しい成功後の表示を巻き戻さない。
 await toggle('amazonDeliveryToggle'); await toggle('amazonDeliveryToggle');
 await check(()=>{window.finish(4,'ok',{amazonDeliveryTotalEnabled:false});window.finish(3,'fail');});
 await page.waitForFunction(()=>document.querySelector('#statusMsg').classList.contains('ok'));
 assert.equal(await check(()=>document.querySelector('#amazonDeliveryToggle').checked),false);
 // 同期世代失効時は実際の保存値へ復元する。
 await toggle('amazonMerchantInfoToggle');await check(()=>window.finish(5,'staleGeneration'));await settled();
 assert.equal(await check(()=>document.querySelector('#amazonMerchantInfoToggle').checked),false);
 console.log('PASS false response/exception/stale rejection rollback; different-setting overlap; old same-setting failure ignored');
 // 保存応答待ちに次のドラッグを始めても、inputだけでは送信せず進行値を守る。
 const input=async(id,value,commit=false)=>check((id,value,commit)=>{
  const control=document.getElementById(id); control.value=value;
  control.dispatchEvent(new Event('input',{bubbles:true}));
  if(commit)control.dispatchEvent(new Event('change',{bubbles:true}));
 },id,value,commit);
 const wait=()=>check(()=>new Promise(resolve=>setTimeout(resolve,0)));
 await input('wikipedia-fontSize','20',true); // request 6
 await input('wikipedia-fontSize','22');
 await check(()=>window.finish(6,'fail')); await wait();
 assert.equal(await check(()=>document.querySelector('#wikipedia-fontSize').value),'22');
 await input('wikipedia-fontSize','22',true); // request 7
 await check(()=>window.finish(7,'ok',{wikipediaAppearance:{fontSize:22}})); await wait();
 assert.equal(await check(()=>window.saved.wikipediaAppearance.fontSize),22);
 await input('videoGammaSlider','120',true); // request 8
 await input('videoGammaSlider','140');
 await check(()=>window.finish(8,'throw')); await wait();
 assert.equal(await check(()=>document.querySelector('#videoGammaSlider').value),'140');
 // 別項目の失敗は復元し、編集中のガンマは維持する。
 await toggle('amazonDeliveryToggle'); // request 9
 await check(()=>window.finish(9,'fail')); await wait();
 assert.equal(await check(()=>document.querySelector('#amazonDeliveryToggle').checked),false);
 assert.equal(await check(()=>document.querySelector('#videoGammaSlider').value),'140');
 await input('videoGammaSlider','140',true); // request 10
 await check(()=>window.finish(10,'ok',window.pending[10].message.data)); await wait();
 assert.equal(await check(()=>window.saved.videoGammaValue),await check(()=>window.pending[10].message.data.videoGammaValue));
 console.log('PASS input during prior save failure preserves Wikipedia/gamma draft; next commit and other-field rollback');
 // ルーペONの自動closeは最新保存が成功した時だけ。失敗や応答前には閉じない。
 await page.click('#categoryTrigger'); await page.click('#tabTune');
 await check(()=>[...document.querySelectorAll('.cat-subtab')].find(button=>button.textContent.trim()==='Video').click());
 const pause=()=>check(()=>new Promise(resolve=>setTimeout(resolve,100)));
 await toggle('loupeToggle'); await pause(); // request 11
 assert.equal(await check(()=>window.closeCount),0);
 await check(()=>window.finish(11,'fail')); await pause();
 assert.equal(await check(()=>document.querySelector('#loupeToggle').checked),false);
 assert.equal(await check(()=>window.closeCount),0);
 await toggle('loupeToggle'); await pause(); // request 12
 assert.equal(await check(()=>window.closeCount),0);
 await check(()=>window.finish(12,'ok',{loupeEnabled:true})); await pause();
 assert.equal(await check(()=>window.closeCount),1);
 await toggle('loupeToggle'); // request 13: OFF
 await check(()=>window.finish(13,'ok',{loupeEnabled:false})); await wait();
 await toggle('loupeToggle'); await toggle('loupeToggle'); // requests 14 ON -> 15 OFF
 await check(()=>{window.finish(14,'ok');window.finish(15,'ok',{loupeEnabled:false});}); await pause();
 assert.equal(await check(()=>window.closeCount),1);
 assert.equal(await check(()=>document.querySelector('#loupeToggle').checked),false);
 console.log('PASS loupe keeps popup open on failure/pending save; closes on latest success; ON/OFF race stays open');
 // 先行失敗のエラーを、既に進行中だった別項目の成功で直ちに消さない。
 await toggle('videoGammaToggle'); await toggle('videoFillToggle'); // requests 16,17
 await check(()=>window.finish(16,'fail')); await wait();
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('error')),true);
 await check(()=>window.finish(17,'ok',{videoFillEnabled:true})); await wait();
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('error')),true);
 // エラー後に始めた新しい操作の成功は通常のOKへ戻る。
 await toggle('videoGammaToggle'); // request 18
 await check(()=>window.finish(18,'ok',{videoGammaEnabled:true})); await wait();
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('ok')),true);
 console.log('PASS failure A then concurrent success B keeps error; subsequent new success C restores OK');
 // ルーペのcloseは、同時保存と失敗復元の完了後にもエラー境界を確認する。
 const begin=async id=>{const index=await check(()=>window.pending.length);await toggle(id);return index;};
 const finish=async(index,kind,patch)=>check((index,kind,patch)=>window.finish(index,kind,patch),index,kind,patch);
 const loupeOff=async()=>{
  const index=await begin('loupeToggle');await finish(index,'ok',{loupeEnabled:false});await wait();
 };
 const closeCount=await check(()=>window.closeCount);
 let failing=await begin('videoGammaToggle');
 let loupe=await begin('loupeToggle');
 await finish(failing,'fail');await wait();
 await finish(loupe,'ok',{loupeEnabled:true});await pause();
 assert.equal(await check(()=>window.closeCount),closeCount);
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('error')),true);
 await loupeOff();
 failing=await begin('videoGammaToggle');loupe=await begin('loupeToggle');
 await check((loupe,failing)=>{window.finish(loupe,'ok',{loupeEnabled:true});window.finish(failing,'fail');},loupe,failing);
 await pause();
 assert.equal(await check(()=>window.closeCount),closeCount);
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('error')),true);
 await loupeOff();
 failing=await begin('videoGammaToggle');loupe=await begin('loupeToggle');
 await check((failing,loupe)=>{
  window.holdSettingsRead=true;window.finish(failing,'fail');window.finish(loupe,'ok',{loupeEnabled:true});
 },failing,loupe);
 await pause();
 assert.equal(await check(()=>window.delayedReads.length),1);
 assert.equal(await check(()=>window.closeCount),closeCount);
 await check(()=>{window.holdSettingsRead=false;window.delayedReads.shift()();});await pause();
 assert.equal(await check(()=>window.closeCount),closeCount);
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('error')),true);
 // 元の要求がOFFなら、応答前に外からONが通知されても自動closeしない。
 const off=await begin('loupeToggle');
 await check(()=>window.emit({loupeEnabled:true}));await finish(off,'ok');await pause();
 assert.equal(await check(()=>document.querySelector('#loupeToggle').checked),true);
 assert.equal(await check(()=>window.closeCount),closeCount);
 await loupeOff();
 // close待機中に新しい操作が始まった場合も、その完了まで待つ。
 const earlier=await begin('videoGammaToggle');loupe=await begin('loupeToggle');
 await finish(loupe,'ok',{loupeEnabled:true});await pause();
 const later=await begin('videoFillToggle');
 await finish(earlier,'ok',await check(index=>window.pending[index].message.data,earlier));await pause();
 assert.equal(await check(()=>window.closeCount),closeCount);
 await finish(later,'fail');await pause();
 assert.equal(await check(()=>window.closeCount),closeCount);
 assert.equal(await check(()=>document.querySelector('#statusMsg').classList.contains('error')),true);
 console.log('PASS loupe waits concurrent restoration/new requests; both failure response orders keep errors; original OFF never closes');
 // エラーは操作位置によらず実際に見え、従来の1.5秒を過ぎても読める。
 await page.setViewport({width:460,height:600});
 await check(()=>window.scrollTo(0,0));
 await check(()=>new Promise(resolve=>setTimeout(resolve,1700)));
 const visibleError=()=>check(()=>{
  const status=document.querySelector('#statusMsg');const rect=status.getBoundingClientRect();
  const style=window.getComputedStyle(status);
  return status.classList.contains('error') && status.textContent.trim().length>0 &&
   rect.width>0 && rect.height>0 && rect.top>=0 && rect.bottom<=window.innerHeight &&
   rect.left>=0 && rect.right<=window.innerWidth && style.visibility==='visible' &&
   style.opacity==='1' && style.backgroundColor!=='rgba(0, 0, 0, 0)' && status.checkVisibility();
 });
 assert.equal(await visibleError(),true);
 assert.equal(await check(()=>document.querySelector('#statusMsg').textContent),'⚠️ Could not save or apply settings');
 await page.screenshot({path:path.join(output,"error-top.png")});
 await check(()=>window.scrollTo(0,(document.documentElement.scrollHeight-window.innerHeight)/2));
 assert.ok(await check(()=>window.scrollY)>0);
 assert.equal(await visibleError(),true);
 await page.screenshot({path:path.join(output,"error-middle.png")});
 console.log('PASS error visible at top/middle scroll and persists beyond 1.5 seconds');
 assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(output,"popup.png")});
 console.log('PASS no page errors');
 } finally {await browser.close();}
});
