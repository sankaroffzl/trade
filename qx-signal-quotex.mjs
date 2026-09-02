import 'dotenv/config';
import { firefox } from 'playwright';
import { RSI, EMA } from 'technicalindicators';
import fs from 'fs';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const QX_EMAIL = process.env.QX_EMAIL;
const QX_PASS = process.env.QX_PASSWORD || process.env.QX_PASS;

if (!QX_EMAIL || !QX_PASS) {
  console.error('Missing QX_EMAIL / QX_PASSWORD in .env (Quotex DEMO only)');
  console.error('Add: QX_EMAIL=demo@email.com  QX_PASSWORD=pass');
  process.exit(1);
}

const SUB_FILE = './subscribers.json';
let subscribers = new Set();
try {
  if (TG_CHAT) TG_CHAT.split(',').map(s=>s.trim()).filter(Boolean).forEach(id=> subscribers.add(id));
  if (fs.existsSync(SUB_FILE)) JSON.parse(fs.readFileSync(SUB_FILE,'utf8')).forEach(id=> subscribers.add(String(id)));
} catch {}
function saveSubs(){ try{ fs.writeFileSync(SUB_FILE, JSON.stringify([...subscribers])); }catch{} }
let tgOffset = 0;
async function pollTelegram(){
  if (!TG_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${tgOffset}&timeout=0`);
    const j = await res.json();
    if (j.ok && j.result.length) {
      for (const u of j.result) {
        tgOffset = u.update_id + 1;
        const chatId = String(u.message?.chat?.id || '');
        const text = (u.message?.text || '').trim();
        if (!chatId) continue;
        if (!subscribers.has(chatId)) { subscribers.add(chatId); saveSubs(); console.log(`👤 New sub ${chatId}`); }
        if (text === '/start') await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: chatId, text:'✅ Subscribed to Quotex EXACT signals (Quotex time :00)' })});
        if (text === '/stop') { subscribers.delete(chatId); saveSubs(); }
      }
    }
  } catch {}
}
async function sendTelegram(text){
  if (!TG_TOKEN || subscribers.size===0) return;
  for (const chatId of subscribers) {
    try { await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: chatId, text, parse_mode:'Markdown' }) }); } catch {}
  }
}

const MARKETS = ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','EUR/JPY','GBP/JPY','EUR/GBP','USD/CHF','AUD/JPY','NZD/USD','BTC/USD'];
const history = new Map(); MARKETS.forEach(m=> history.set(m, []));
const pending = []; let wins=0, losses=0;
const STRICT=true, MIN_SCORE=12;

function calcSignal(prices){
  if(prices.length<22) return {signal:'WAIT', rsi:null, trend:'--', score:-999, reason:`collecting ${prices.length}/22`};
  const rsiArr=RSI.calculate({period:14, values:prices});
  const ema9Arr=EMA.calculate({period:9, values:prices});
  const ema21Arr=EMA.calculate({period:21, values:prices});
  const ema50Arr=prices.length>=50? EMA.calculate({period:50, values:prices}):null;
  const rsi=rsiArr[rsiArr.length-1], ema9=ema9Arr[ema9Arr.length-1], ema21=ema21Arr[ema21Arr.length-1], ema50=ema50Arr?ema50Arr[ema50Arr.length-1]:prices[prices.length-1];
  const price=prices[prices.length-1], trend=price>ema50?'UP':price<ema50?'DOWN':'FLAT';
  const crossUp=ema9>ema21, crossDown=ema9<ema21, nearEma50=Math.abs(price-ema50)/price<0.0008, emaGap=Math.abs(ema9-ema21)/price*1000;
  if(rsi===undefined) return {signal:'WAIT', rsi, trend, score:-999, reason:'warming'};
  let score=Math.abs(rsi-50)*0.6 + emaGap*2;
  if(trend==='UP'&&crossUp) score+=8; if(trend==='DOWN'&&crossDown) score+=8;
  if(nearEma50) score-=6; if(rsi>45&&rsi<55) score-=8;
  if(rsi<32) return {signal:'BUY', rsi, trend, score:score+12, reason:`RSI oversold ${rsi.toFixed(1)}`};
  if(rsi>68) return {signal:'SELL', rsi, trend, score:score+12, reason:`RSI overbought ${rsi.toFixed(1)}`};
  if(trend==='UP'&&crossUp&&rsi>=30&&rsi<=50) return {signal:'BUY', rsi, trend, score:score+5, reason:`UP EMA9>EMA21 RSI ${rsi.toFixed(1)}`};
  if(trend==='DOWN'&&crossDown&&rsi>=50&&rsi<=70) return {signal:'SELL', rsi, trend, score:score+5, reason:`DOWN EMA9<EMA21 RSI ${rsi.toFixed(1)}`};
  if(nearEma50) return {signal:'SKIP', rsi, trend, score, reason:'choppy near EMA50'};
  if(rsi>45&&rsi<55) return {signal:'SKIP', rsi, trend, score, reason:`RSI ${rsi.toFixed(1)} neutral`};
  return {signal:'SKIP', rsi, trend, score, reason:`no setup RSI ${rsi.toFixed(1)}`};
}

async function getQuotexPrice(page){
  try {
    const price = await page.evaluate(()=>{
      const els = Array.from(document.querySelectorAll('*'));
      for(const el of els){
        const t=(el.innerText||'').trim();
        if(/^\d+\.\d{3,5}$/.test(t) && parseFloat(t)>0.5 && parseFloat(t)<500) return t;
      }
      return null;
    });
    return price? parseFloat(price): null;
  } catch { return null; }
}

async function main(){
  console.log(`\n=== Quotex EXACT SIGNAL (Quotex time :00) ===\nLogin: ${QX_EMAIL.replace(/(.{2}).*(@.*)/,'$1***$2')} | Markets: ${MARKETS.length} | Strict ON | Telegram ${subscribers.size} subs\n`);
  if(TG_TOKEN){ setInterval(pollTelegram,5000); pollTelegram(); console.log('Telegram public mode ON'); }
  const browser = await firefox.launch({ headless: false });
  const ctx = await browser.newContext({viewport:{width:1366,height:850}});
  const page = await ctx.newPage();
  console.log('→ Opening Quotex sign-in...');
  await page.goto('https://qxbroker.com/en/sign-in', {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1500);
  let emailEl = page.locator('input[type="text"], input[type="email"]').filter({visible:true}).first();
  let passEl = page.locator('input[type="password"]').filter({visible:true}).first();
  await emailEl.click(); await emailEl.fill(QX_EMAIL); await page.waitForTimeout(300);
  await passEl.click(); await passEl.evaluate((el,pwd)=>{ el.focus(); el.value=pwd; el.dispatchEvent(new Event('input',{bubbles:true})); }, QX_PASS);
  await page.waitForTimeout(400);
  const btn = page.getByRole('button',{name:/Sign in/i}).first();
  if(await btn.isVisible().catch(()=>false)) await btn.click(); else await page.keyboard.press('Enter');
  console.log('→ Waiting login...');
  await page.waitForURL(/\/trade|\/cabinet/i, {timeout:30000}).catch(async()=>{ console.log('Still on sign-in, solve captcha manually'); await page.waitForURL(/\/trade|\/cabinet/i,{timeout:60000}); });
  if(!/\/trade/.test(page.url())){ await page.goto('https://qxbroker.com/en/trade',{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2000); }
  console.log(`→ On ${page.url()} - collecting Quotex prices at exact :00`);

  let tick=0;
  const delayToNext = 60000 - (Date.now()%60000) + 500;
  console.log(`Next exact signal in ${Math.round(delayToNext/1000)}s at :00`);
  await new Promise(r=> setTimeout(r, delayToNext));

  setInterval(async()=>{
    const now=new Date(); const time=now.toLocaleTimeString('en-GB',{hour12:false}); const sec=now.getSeconds();
    const price = await getQuotexPrice(page);
    if(!price){ console.log(`[${time}] No price from Quotex DOM - retry`); return; }
    const activeMarket = await page.evaluate(()=>{ const el=document.querySelector('[class*="asset"]'); return el? el.innerText.trim().slice(0,20): 'EUR/USD'; }).catch(()=> 'EUR/USD');
    const market = MARKETS.includes(activeMarket)? activeMarket : 'EUR/USD';
    const arr=history.get(market); arr.push(price); if(arr.length>60) arr.shift();
    const s=calcSignal(arr);
    const stars=s.score>15?'⭐⭐⭐ HIGH':s.score>8?'⭐⭐ MEDIUM':'⭐ LOW';
    const entryAdvice=sec<=10?`✅ ENTRY NOW (${sec}s)`:`⏳ WAIT ${60-sec}s`;
    console.log(`\n[${time}] Quotex ${market} ${price.toFixed(5)} RSI ${s.rsi?.toFixed(1)??'--'} ${s.signal} Score ${s.score.toFixed(1)} ${stars} | ${entryAdvice}`);
    console.log(`Reason: ${s.reason}`);

    // pending check
    const nowMs=Date.now();
    for(let i=pending.length-1;i>=0;i--){
      const p=pending[i];
      if(nowMs-p.ts>=60000){
        const win=(p.signal==='BUY'&&price>p.price)||(p.signal==='SELL'&&price<p.price);
        if(win) wins++; else losses++;
        const wr=((wins/(wins+losses))*100).toFixed(1);
        console.log(`${win?'✅ WIN':'❌ LOSS'} ${p.market} ${p.signal} @${p.price.toFixed(5)} → ${price.toFixed(5)} | W:${wins} L:${losses} WR:${wr}%`);
        sendTelegram(`${win?'✅ WIN':'❌ LOSS'} *${p.market}* ${p.signal} @${p.price.toFixed(5)} → ${price.toFixed(5)} | *W:${wins} L:${losses} WR:${wr}%*`);
        pending.splice(i,1);
      }
    }

    if((s.signal==='BUY'||s.signal==='SELL') && s.score>=MIN_SCORE && stars!=='⭐ LOW'){
      console.log(`🟢 PERFECT MARKET ${market} ${s.signal} ${stars} - Trade NOW 1m $1 | Candle ${sec}s ${entryAdvice}`);
      pending.push({market, price, signal:s.signal, score:s.score, ts:nowMs});
      try{ process.stdout.write('\x07'); }catch{}
      sendTelegram(`🟢 *PERFECT MARKET (Quotex EXACT)*\n*Market:* ${market}\n*Signal:* ${s.signal} (1 MIN)\n*Time:* ${time} | Candle ${sec}s | ${entryAdvice}\n*Price:* ${price.toFixed(5)} RSI ${s.rsi?.toFixed(1)} Score ${s.score.toFixed(1)} ${stars}\n*Reason:* ${s.reason}\n_Quotex time :00 exact_`);
    } else {
      console.log(`⚪ WAIT - ${s.signal} Score ${s.score.toFixed(1)} ${stars} < STRICT - no trade`);
    }
  }, 60000);
}

main().catch(e=>{ console.error('Fatal',e); process.exit(1); });
