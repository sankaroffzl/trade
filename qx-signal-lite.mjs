import { RSI, EMA } from 'technicalindicators';
import 'dotenv/config';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown' })
    });
  } catch(e){ console.error('Telegram error:', e.message); }
}

const MARKETS = [
  { name: 'EUR/USD', yahoo: 'EURUSD=X' },
  { name: 'EUR/USD OTC', yahoo: 'EURUSD=X' },
  { name: 'GBP/USD', yahoo: 'GBPUSD=X' },
  { name: 'GBP/USD OTC', yahoo: 'GBPUSD=X' },
  { name: 'USD/JPY', yahoo: 'JPY=X' },
  { name: 'USD/JPY OTC', yahoo: 'JPY=X' },
  { name: 'AUD/USD', yahoo: 'AUDUSD=X' },
  { name: 'AUD/USD OTC', yahoo: 'AUDUSD=X' },
  { name: 'USD/CAD', yahoo: 'CAD=X' },
  { name: 'EUR/JPY', yahoo: 'EURJPY=X' },
  { name: 'GBP/JPY', yahoo: 'GBPJPY=X' },
  { name: 'BTC/USD OTC', yahoo: 'BTC-USD' },
  { name: 'EUR/GBP', yahoo: 'EURGBP=X' },
  { name: 'USD/CHF', yahoo: 'CHF=X' },
  { name: 'AUD/JPY', yahoo: 'AUDJPY=X' },
  { name: 'NZD/USD', yahoo: 'NZDUSD=X' },
];

const STRICT = true;
const MIN_SCORE = 12;

const history = new Map();
for (const m of MARKETS) history.set(m.name, []);
const pending = [];
let wins = 0, losses = 0;

function calcSignal(prices){
  if (prices.length < 22) return { signal:'WAIT', reason:`collecting ${prices.length}/22`, rsi:null, trend:'--', score:-999 };
  const rsiArr = RSI.calculate({period:14, values: prices});
  const ema9Arr = EMA.calculate({period:9, values: prices});
  const ema21Arr = EMA.calculate({period:21, values: prices});
  const ema50Arr = prices.length >= 50 ? EMA.calculate({period:50, values: prices}) : null;
  const rsi = rsiArr[rsiArr.length-1];
  const ema9 = ema9Arr[ema9Arr.length-1];
  const ema21 = ema21Arr[ema21Arr.length-1];
  const ema50 = ema50Arr ? ema50Arr[ema50Arr.length-1] : prices[prices.length-1];
  const price = prices[prices.length-1];
  const trend = price > ema50 ? 'UP' : price < ema50 ? 'DOWN' : 'FLAT';
  const crossUp = ema9 > ema21;
  const crossDown = ema9 < ema21;
  const nearEma50 = Math.abs(price - ema50) / price < 0.0008;
  const emaGap = Math.abs(ema9 - ema21) / price * 1000;
  if (rsi === undefined || ema9 === undefined) return { signal:'WAIT', reason:'warming up', rsi, trend, score:-999 };
  let score = 0;
  score += Math.abs(rsi - 50) * 0.6;
  score += emaGap * 2;
  if (trend === 'UP' && crossUp) score += 8;
  if (trend === 'DOWN' && crossDown) score += 8;
  if (nearEma50) score -= 6;
  if (rsi > 45 && rsi < 55) score -= 8;

  if (rsi < 32) return { signal:'BUY', reason:`RSI oversold ${rsi.toFixed(1)}${crossUp?' + EMA cross':''}`, rsi, trend, score: score+12, emaGap };
  if (rsi > 68) return { signal:'SELL', reason:`RSI overbought ${rsi.toFixed(1)}${crossDown?' + EMA cross':''}`, rsi, trend, score: score+12, emaGap };
  if (trend === 'UP' && crossUp && rsi >= 30 && rsi <= 50) return { signal:'BUY', reason:`UP trend, EMA9>EMA21, RSI ${rsi.toFixed(1)}`, rsi, trend, score: score+5, emaGap };
  if (trend === 'DOWN' && crossDown && rsi >= 50 && rsi <= 70) return { signal:'SELL', reason:`DOWN trend, EMA9<EMA21, RSI ${rsi.toFixed(1)}`, rsi, trend, score: score+5, emaGap };
  if (nearEma50) return { signal:'SKIP', reason:`choppy near EMA50`, rsi, trend, score, emaGap };
  if (rsi > 45 && rsi < 55) return { signal:'SKIP', reason:`RSI ${rsi.toFixed(1)} neutral`, rsi, trend, score, emaGap };
  return { signal:'SKIP', reason:`no setup (RSI ${rsi.toFixed(1)}, ${trend})`, rsi, trend, score, emaGap };
}

async function fetch1mCloses(yahooSymbol){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const result = j.chart?.result?.[0];
  if (!result) throw new Error('no result');
  const closes = result.indicators?.quote?.[0]?.close;
  const timestamps = result.timestamp;
  if (!closes) throw new Error('no closes');
  const valid = closes.map((c,i)=> ({c, t:timestamps[i]})).filter(x=> x.c != null);
  return valid;
}

async function scanAll(){
  const results = [];
  for (const m of MARKETS) {
    try {
      const data = await fetch1mCloses(m.yahoo);
      const closes = data.map(d=> d.c);
      const last = closes[closes.length-1];
      const arr = history.get(m.name);
      if (arr.length === 0) {
        const seed = closes.slice(-60);
        arr.push(...seed);
      } else {
        if (last !== arr[arr.length-1]) {
          arr.push(last);
          if (arr.length > 60) arr.shift();
        }
      }
      const prices = history.get(m.name);
      const s = calcSignal(prices);
      results.push({ market: m.name, price: last, rsi: s.rsi, trend: s.trend, signal: s.signal, reason: s.reason, score: s.score, emaGap: s.emaGap });
    } catch(e){
      results.push({ market: m.name, price: null, rsi: null, trend: '--', signal: 'ERR', reason: e.message.slice(0,40), score: -999 });
    }
    await new Promise(r=>setTimeout(r, 110));
  }
  results.sort((a,b)=> b.score - a.score);
  return results;
}

async function main(){
  const tgStatus = TG_TOKEN && TG_CHAT ? `Telegram: ON → ${TG_CHAT}` : 'Telegram: OFF (add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to .env to enable phone push)';
  console.log(`
=== Quotex SIGNAL LITE - Compare All Markets - Perfect Market Picker ===
Source: Yahoo Finance 1m (real market)
Strategy: RSI14 + EMA9/21 + EMA50, 1min expiry - compares all 16, shows #1 perfect
Mode: SIGNAL ONLY - you trade manually | ${tgStatus}
Strict: ${STRICT ? `ON (min Score ${MIN_SCORE}, HIGH/MEDIUM only)` : 'OFF'} | W:${wins} L:${losses}
Risk: Educational only. Not financial advice. High-risk.
`);

  console.log('→ Warming up...');
  let results = await scanAll();
  printComparison(results);

  console.log(`\n--- Live every 15s - compares all 16, shows perfect market (Ctrl+C to stop) ---`);
  setInterval(async()=>{
    results = await scanAll();
    printComparison(results);
  }, 15000);
}

function printComparison(results){
  const time = new Date().toLocaleTimeString('en-GB', {hour12:false});

  // Check pending WIN/LOSS (1 min expiry)
  const now = Date.now();
  for(let i=pending.length-1; i>=0; i--){
    const p = pending[i];
    if (now - p.ts >= 60000) {
      const cur = results.find(r=> r.market === p.market);
      if (cur && cur.price) {
        const win = (p.signal==='BUY' && cur.price > p.price) || (p.signal==='SELL' && cur.price < p.price);
        if (win) wins++; else losses++;
        const total = wins+losses;
        const wr = total ? ((wins/total)*100).toFixed(1) : '0.0';
        const icon = win ? '✅ WIN ' : '❌ LOSS';
        console.log(`\n${icon} | ${p.market} ${p.signal} @ ${p.price.toFixed(5)} → ${cur.price.toFixed(5)} | Held 1m | Score ${p.score.toFixed(1)} | W:${wins} L:${losses} WR:${wr}%`);
        if (total) console.log(`   Session: ${wins}W-${losses}L (${wr}% win rate) - Educational only, past 1m does not predict next`);
        sendTelegram(`${icon} *${p.market}* ${p.signal} @ ${p.price.toFixed(5)} → ${cur.price.toFixed(5)} | 1m | Score ${p.score.toFixed(1)} | *W:${wins} L:${losses} WR:${wr}%*`);
      }
      pending.splice(i,1);
    }
  }

  console.log(`\n[${time}] Compared 16 markets - ranked by accuracy:`);
  console.log(` Rank | Market         | Signal     | Price      | RSI   | Trend | Score | Reason`);
  console.log(` ---- | -------------- | ---------- | ---------- | ----- | ----- | ----- | ----------------`);
  results.slice(0,8).forEach((r,i)=>{
    const rank = i===0 ? '⭐ #1' : `  #${i+1}`;
    const sig = r.signal==='BUY' ? '🟢 BUY ' : r.signal==='SELL' ? '🔴 SELL' : r.signal==='SKIP' ? '⚪ SKIP' : '⏳ WAIT';
    const price = r.price ? r.price.toFixed(r.price>100 ? 2 : 5) : '---';
    const rsi = r.rsi ? r.rsi.toFixed(1).padStart(5) : ' --';
    console.log(`${rank} | ${r.market.padEnd(14)} | ${sig} | ${price.padStart(10)} | ${rsi} | ${r.trend.padEnd(4)} | ${r.score.toFixed(1).padStart(5)} | ${r.reason}`);
  });

  const best = results[0];
  console.log('');
  if (best.signal === 'BUY' || best.signal === 'SELL') {
    const arrow = best.signal === 'BUY' ? '🟢' : '🔴';
    const dir = best.signal === 'BUY' ? 'BUY ↑' : 'SELL ↓';
    const stars = best.score > 15 ? '⭐⭐⭐ HIGH' : best.score > 8 ? '⭐⭐ MEDIUM' : '⭐ LOW';
    const strictPass = !STRICT || (best.score >= MIN_SCORE && stars !== '⭐ LOW');
    if (!strictPass) {
      console.log(`⚪ Filtered: Best is ${best.market} ${best.signal} but Score ${best.score.toFixed(1)} ${stars} < STRICT ${MIN_SCORE} — SKIPPED (no beep)`);
      console.log(`   → Strict ON: only Score ≥${MIN_SCORE} + MEDIUM/HIGH trades. Choppy/LOW signals silenced.`);
      const nextGood = results.find(r=> (r.signal==='BUY'||r.signal==='SELL') && r.score >= MIN_SCORE);
      if (nextGood) console.log(`   → Next good: ${nextGood.market} ${nextGood.signal} Score ${nextGood.score.toFixed(1)}`);
    } else {
      console.log(`${arrow} ┌─ PERFECT MARKET (Best of 16) ──────────`);
      console.log(`   │ Market: ${best.market}`);
      console.log(`   │ Signal: ${dir}  (1 MIN)`);
      console.log(`   │ Time: ${time}`);
      console.log(`   │ Price: ${best.price.toFixed(5)}  RSI: ${best.rsi.toFixed(1)}  Trend: ${best.trend}  Score: ${best.score.toFixed(1)} ${stars}`);
      console.log(`   │ Reason: ${best.reason}`);
      console.log(`   └─────────────────────────────────`);
      console.log(`   👉 Trade this ONE market manually on Quotex (1m expiry, $1)`);
      const already = pending.find(p=> p.market===best.market && now - p.ts < 30000);
      if (!already) {
        pending.push({ market: best.market, price: best.price, signal: best.signal, score: best.score, ts: now });
        process.stdout.write('\x07');
        console.log(`   🔔 BEEP + queued for 1m result check (W:${wins} L:${losses})`);
        const stars2 = best.score > 15 ? '⭐⭐⭐ HIGH' : best.score > 8 ? '⭐⭐ MEDIUM' : '⭐ LOW';
        const arrow2 = best.signal === 'BUY' ? '🟢' : '🔴';
        sendTelegram(`${arrow2} *PERFECT MARKET* ⭐ #1/16\n*Market:* ${best.market}\n*Signal:* ${best.signal} ↑ (1 MIN)\n*Time:* ${time}\n*Price:* ${best.price.toFixed(5)}  RSI: ${best.rsi.toFixed(1)}  Trend: ${best.trend}  Score: ${best.score.toFixed(1)} ${stars2}\n*Reason:* ${best.reason}\n_Trade manually on Quotex 1m, $1_`);
      }
    }
  } else {
    console.log(`⚪ No BUY/SELL this scan - Best candidate is ${best.market} but still ${best.signal} (${best.reason})`);
    console.log(`   → Perfect market says WAIT - don't trade this minute. Best of 16 is still not good enough.`);
    const nextBest = results.find(r=> r.signal==='BUY' || r.signal==='SELL');
    if (nextBest) console.log(`   → Next closest signal: ${nextBest.market} ${nextBest.signal} Score ${nextBest.score.toFixed(1)}`);
  }
}

main().catch(e=>{ console.error('Fatal:', e); process.exit(1); });
