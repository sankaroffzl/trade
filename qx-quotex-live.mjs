import 'dotenv/config';
import { firefox } from 'playwright';
import { RSI, EMA } from 'technicalindicators';
import fs from 'fs';

const QX_EMAIL = process.env.QX_EMAIL;
const QX_PASS = process.env.QX_PASSWORD || process.env.QX_PASS;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
if (!QX_EMAIL || !QX_PASS) { console.error('Add QX_EMAIL and QX_PASSWORD to .env (DEMO only)'); process.exit(1); }

const SUB_FILE='./subscribers.json';
let subs=new Set();
try{
  if(TG_CHAT) TG_CHAT.split(',').map(s=>s.trim()).filter(Boolean).forEach(id=> subs.add(id));
  if(fs.existsSync(SUB_FILE)) JSON.parse(fs.readFileSync(SUB_FILE,'utf8')).forEach(id=> subs.add(String(id)));
}catch{}
function save(){ try{ fs.writeFileSync(SUB_FILE, JSON.stringify([...subs])); }catch{} }
let off=0;
async function pollTG(){
  if(!TG_TOKEN) return;
  try{
    const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${off}&timeout=0`);
    const j=await r.json();
    if(j.ok) for(const u of j.result){ off=u.update_id+1; const id=String(u.message?.chat?.id||''); const t=(u.message?.text||'').trim(); if(!id) continue; if(!subs.has(id)){ subs.add(id); save(); console.log(`👤 ${id}`);} if(t==='/start') await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:id,text:'✅ Live Quotex feed subscribed'})}); if(t==='/stop'){ subs.delete(id); save(); } }
  }catch{}
}
async function sendTG(txt){ if(!TG_TOKEN||subs.size===0) return; for(const id of subs) try{ await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:id,text:txt,parse_mode:'Markdown'})}); }catch{} }

const MARKETS=['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','EUR/JPY','GBP/JPY','EUR/GBP','USD/CHF','AUD/JPY','NZD/USD','BTC/USD'];
const hist=new Map(); MARKETS.forEach(m=> hist.set(m, []));
let wins=0,losses=0,pending=[];
function calc(prices){
  if(prices.length<22) return {signal:'WAIT',rsi:null,trend:'--',score:-999,reason:`${prices.length}/22`};
  const rsiArr=RSI.calculate({period:14,values:prices}); const e9=EMA.calculate({period:9,values:prices}); const e21=EMA.calculate({period:21,values:prices}); const e50=prices.length>=50?EMA.calculate({period:50,values:prices}):null;
  const rsi=rsiArr[rsiArr.length-1], ema9=e9[e9.length-1], ema21=e21[e21.length-1], ema50=e50?e50[e50.length-1]:prices[prices.length-1];
  const price=prices[prices.length-1], trend=price>ema50?'UP':price<ema50?'DOWN':'FLAT';
  const crossUp=ema9>ema21, crossDown=ema9<ema21, near=Math.abs(price-ema50)/price<0.0008, gap=Math.abs(ema9-ema21)/price*1000;
  let score=Math.abs(rsi-50)*0.6+gap*2; if(trend==='UP'&&crossUp) score+=8; if(trend==='DOWN'&&crossDown) score+=8; if(near) score-=6; if(rsi>45&&rsi<55) score-=8;
  if(rsi<32) return {signal:'BUY',rsi,trend,score:score+12,reason:`RSI ${rsi.toFixed(1)} oversold`};
  if(rsi>68) return {signal:'SELL',rsi,trend,score:score+12,reason:`RSI ${rsi.toFixed(1)} overbought`};
  if(trend==='UP'&&crossUp&&rsi>=30&&rsi<=50) return {signal:'BUY',rsi,trend,score:score+5,reason:`UP EMA9>21 RSI ${rsi.toFixed(1)}`};
  if(trend==='DOWN'&&crossDown&&rsi>=50&&rsi<=70) return {signal:'SELL',rsi,trend,score:score+5,reason:`DOWN EMA9<21 RSI ${rsi.toFixed(1)}`};
  if(near) return {signal:'SKIP',rsi,trend,score,reason:'near EMA50 choppy'};
  if(rsi>45&&rsi<55) return {signal:'SKIP',rsi,trend,score,reason:`RSI ${rsi.toFixed(1)} neutral`};
  return {signal:'SKIP',rsi,trend,score,reason:`no setup RSI ${rsi.toFixed(1)}`};
}

async function getPrice(page){
  try{
    return await page.evaluate(()=>{
      const all=[...document.querySelectorAll('*')];
      for(const el of all){ const t=(el.innerText||'').trim(); if(/^\d+\.\d{3,5}$/.test(t)){ const v=parseFloat(t); if(v>0.4&&v<500) return String(t); } }
      return null;
    });
  }catch{ return null; }
}

async function main(){
  console.log(`\n=== Quotex LIVE (hidden, no popup) ===\nLogin ${QX_EMAIL.replace(/(.{2}).*(@.*)/,'$1***$2')} | Markets ${MARKETS.length}\n`);
  if(TG_TOKEN){ setInterval(pollTG,5000); pollTG(); console.log('Telegram ON'); }
  const browser=await firefox.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await ctx.newPage();
  page.on('console',m=> console.log('[browser]',m.text().slice(0,200)));
  console.log('→ Logging to Quotex (headless, no window)...');
  await page.goto('https://qxbroker.com/en/sign-in',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1500);
  let eEl=page.locator('input[type="text"], input[type="email"]').filter({visible:true}).first();
  let pEl=page.locator('input[type="password"]').filter({visible:true}).first();
  await eEl.click(); await eEl.fill(QX_EMAIL); await page.waitForTimeout(300);
  await pEl.click(); await pEl.evaluate((el,p)=>{el.focus(); el.value=p; el.dispatchEvent(new Event('input',{bubbles:true}));},QX_PASS);
  await page.waitForTimeout(400);
  const b=page.getByRole('button',{name:/Sign in/i}).first();
  if(await b.isVisible().catch(()=>false)) await b.click(); else await page.keyboard.press('Enter');
  console.log('→ Waiting for trade page...');
  const ok=await page.waitForURL(/\/trade|\/cabinet/i,{timeout:30000}).then(()=>true).catch(async()=>{ await page.screenshot({path:'debug-live-login.png'}).catch(()=>{}); console.log('Still on sign-in, login failed - check .env password / PIN'); return false; });
  if(!ok){ await browser.close(); process.exit(2); }
  if(!/\/trade/.test(page.url())){ await page.goto('https://qxbroker.com/en/trade',{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2000); }
  console.log(`→ On ${page.url()} - live feed starting (no window popup)`);
  await page.waitForTimeout(2000);

  // live price ticker every 2s
  setInterval(async()=>{
    const p=await getPrice(page);
    const t=new Date().toLocaleTimeString('en-GB',{hour12:false});
    const ms=String(new Date().getMilliseconds()).padStart(3,'0');
    if(p) console.log(`[LIVE ${t}.${ms}] Quotex price ${p}`);
  },2000);

  // signal every 60s at :00
  const delay=60000 - (Date.now()%60000);
  console.log(`Next signal in ${Math.round(delay/1000)}s at :00`);
  setTimeout(()=>{
    setInterval(async()=>{
      const now=new Date(); const time=now.toLocaleTimeString('en-GB',{hour12:false}); const sec=now.getSeconds();
      const priceStr=await getPrice(page); const price=priceStr? parseFloat(priceStr): null;
      if(!price){ console.log(`[${time}] No price yet`); return; }
      const market='EUR/USD';
      const arr=hist.get(market); arr.push(price); if(arr.length>60) arr.shift();
      const s=calc(arr);
      const stars=s.score>15?'⭐⭐⭐ HIGH':s.score>8?'⭐⭐ MEDIUM':'⭐ LOW';
      const entry=sec<=10?`✅ ENTRY NOW ${sec}s`:`⏳ WAIT ${60-sec}s`;
      console.log(`\n[${time}] LIVE ${market} ${price.toFixed(5)} RSI ${s.rsi?.toFixed(1)??'--'} ${s.signal} Score ${s.score.toFixed(1)} ${stars} | ${entry} | ${s.reason}`);

      const nowMs=Date.now();
      for(let i=pending.length-1;i>=0;i--){ const pe=pending[i]; if(nowMs-pe.ts>=60000){ const win=(pe.signal==='BUY'&&price>pe.price)||(pe.signal==='SELL'&&price<pe.price); if(win) wins++; else losses++; const wr=wins+losses?((wins/(wins+losses))*100).toFixed(1):'0'; console.log(`${win?'✅ WIN':'❌ LOSS'} ${pe.market} @${pe.price.toFixed(5)}→${price.toFixed(5)} W:${wins} L:${losses} WR:${wr}%`); sendTG(`${win?'✅ WIN':'❌ LOSS'} *${pe.market}* ${pe.signal} @${pe.price.toFixed(5)}→${price.toFixed(5)} W:${wins} L:${losses} ${wr}%`); pending.splice(i,1); } }

      if((s.signal==='BUY'||s.signal==='SELL')&&s.score>=12&&stars!=='⭐ LOW'){
        console.log(`🟢 PERFECT ${market} ${s.signal} ${stars} - Trade NOW 1m`);
        pending.push({market,price,signal:s.signal,score:s.score,ts:nowMs});
        try{ process.stdout.write('\x07'); }catch{}
        sendTG(`🟢 *LIVE PERFECT* ${market} ${s.signal} @${price.toFixed(5)} RSI ${s.rsi.toFixed(1)} ${stars} | ${time} ${entry}`);
      } else console.log(`⚪ SKIP Score ${s.score.toFixed(1)} ${stars} - wait`);
    },60000);
  },delay);
}
main().catch(e=>{console.error(e);process.exit(1);});
