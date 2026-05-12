import fetch from "node-fetch";
import fs from "fs";

const INSTANCE_ID = `${process.pid}-${Date.now()}`;
const STATE_FILE = `state.${INSTANCE_ID}.json`;

const CONFIG = {
  INITIAL_CAPITAL: 200,
  RISK_PER_TRADE: 0.02,
  MAX_OPEN_TRADES: 3,
  MAX_POSITIONS_PER_MARKET: 1,
  PRICE_MIN: 0.30,
  PRICE_MAX: 0.70,
  MIN_VOLUME: 300000,
  MIN_LIQ: 100000,
  FEES: 0.02,
  INTERVAL: 5 * 60 * 1000,
  MAX_CONSECUTIVE_LOSSES: 3,
  DRAWDOWN_LIMIT: 0.15,
  STOP_LOSS: 0.03,
  TAKE_PROFIT: 0.05,
  MAX_HOLD_HOURS: 24,
};

const BOTS = {
  A: { MIN_SCORE: 0.20 },
  B: { MIN_SCORE: 0.25 },
  C: { MIN_SCORE: 0.30 },
};

let state = { bots: {}, marketMemory: {} };

const ts = () => new Date().toISOString();
const log = m => console.log(`[${INSTANCE_ID}] [${ts()}] ${m}`);

function initBot() {
  return {
    cash: CONFIG.INITIAL_CAPITAL,
    openTrades: [],
    closedTrades: [],
    consecutiveLosses: 0,
    peakEquity: CONFIG.INITIAL_CAPITAL,
    paused: false,
  };
}

for (const k of Object.keys(BOTS)) state.bots[k] = initBot();

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE));
    for (const k of Object.keys(BOTS)) state.bots[k] ??= initBot();
    log("STATE LOADED");
  } catch { log("NEW STATE"); }
}

const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state,null,2));

function extractPrice(m){
  try{
    const p=JSON.parse(m.outcomePrices||'[]').map(Number).filter(x=>x>0&&x<1);
    return p[0]||Number(m.lastPrice)||0;
  }catch{return Number(m.lastPrice)||0}
}

async function getMarkets(){
  const r=await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30");
  const d=await r.json();
  return d.map(m=>({slug:m.slug,price:extractPrice(m),volume:+m.volume24hr||0,liquidity:+m.liquidity||0}));
}

function score(m,p){
  if(!p||!p.timestamp||p.price<=0)return 0;
  if(Date.now()-p.timestamp>2*CONFIG.INTERVAL)return 0;
  const move=(m.price-p.price)/p.price;
  const vol=p.volume>0?m.volume/p.volume:1;
  const dist=Math.abs(m.price-.5);
  let s=0;
  if(move>0&&m.price<.65)s+=.25;
  if(vol>1.5)s+=.25;
  if(move>.005&&move<=.05)s+=.30;
  if(dist>.15)s-=.25;
  if(move>.07)s-=.15;
  return Math.max(0,Math.min(1,s));
}

function equity(bot,markets){
  let e=bot.cash;
  for(const t of bot.openTrades){
    const m=markets.find(x=>x.slug===t.slug);
    if(m)e+=t.shares*m.price;
  }
  return e;
}

function duplicate(slug){
  return Object.values(state.bots).flatMap(b=>b.openTrades).find(t=>t.slug===slug);
}

function openTrade(bot,key,m,s){
  if(duplicate(m.slug)){log(`DUPLICATE BLOCKED ${m.slug}`);return false;}
  const size=bot.cash*CONFIG.RISK_PER_TRADE;
  const fee=size*CONFIG.FEES;
  if(bot.cash<size+fee)return false;
  bot.cash-=size+fee;
  bot.openTrades.push({slug:m.slug,entry:m.price,costBasis:size,shares:size/m.price,openedAt:ts(),score:s,bot:key,instance:INSTANCE_ID});
  log(`OPEN ${key} ${m.slug} @${m.price.toFixed(3)} score:${s.toFixed(2)}`);
  return true;
}

function closeTrade(bot,t,price,reason){
  const value=t.shares*price;
  const fee=value*CONFIG.FEES;
  const net=value-fee;
  const pnl=net-t.costBasis;
  bot.cash+=net;
  bot.closedTrades.push({...t,exit:price,pnl,reason,closedAt:ts(),durationHours:(Date.now()-new Date(t.openedAt))/3600000});
  bot.openTrades=bot.openTrades.filter(x=>x!==t);
  bot.consecutiveLosses=pnl<0?bot.consecutiveLosses+1:0;
  if(bot.consecutiveLosses>=CONFIG.MAX_CONSECUTIVE_LOSSES)bot.paused=true;
  log(`CLOSE ${reason} pnl:${pnl.toFixed(2)}`);
}

function manage(bot,t,p){
  const move=(p-t.entry)/t.entry;
  const age=(Date.now()-new Date(t.openedAt))/3600000;
  if(age>CONFIG.MAX_HOLD_HOURS)return closeTrade(bot,t,p,'TIMEOUT');
  if(move<=-CONFIG.STOP_LOSS)return closeTrade(bot,t,p,'SL');
  if(move>=CONFIG.TAKE_PROFIT)return closeTrade(bot,t,p,'TP');
}

async function run(){
  let opens=0,closes=0,dupes=0;
  const mkts=await getMarkets();
  const filtered=mkts.filter(m=>m.price>=CONFIG.PRICE_MIN&&m.price<=CONFIG.PRICE_MAX&&m.volume>=CONFIG.MIN_VOLUME&&m.liquidity>=CONFIG.MIN_LIQ);

  for(const m of filtered){
    const prev=state.marketMemory[m.slug];
    for(const k of Object.keys(BOTS)){
      const bot=state.bots[k];
      for(const t of [...bot.openTrades]) if(t.slug===m.slug){manage(bot,t,m.price);closes++;}
      if(bot.paused||bot.openTrades.length>=CONFIG.MAX_OPEN_TRADES||bot.openTrades.some(x=>x.slug===m.slug))continue;
      const s=score(m,prev);
      if(s>=BOTS[k].MIN_SCORE){if(openTrade(bot,k,m,s))opens++;else dupes++;}
    }
    state.marketMemory[m.slug]={price:m.price,volume:m.volume,timestamp:Date.now()};
  }

  for(const k of Object.keys(BOTS)){
    const b=state.bots[k];
    const eq=equity(b,mkts);
    if(eq>b.peakEquity)b.peakEquity=eq;
    if((b.peakEquity-eq)/b.peakEquity>CONFIG.DRAWDOWN_LIMIT)b.paused=true;
    log(`${k} cash:${b.cash.toFixed(2)} eq:${eq.toFixed(2)} trades:${b.closedTrades.length}`);
  }

  log(`SUMMARY opens=${opens} closes=${closes} dupes=${dupes}`);
  saveState();
  setTimeout(run,CONFIG.INTERVAL);
}

loadState();
run();
