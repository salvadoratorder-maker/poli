// ════════════════════════════════════════════════════════════════
//  PolyPaper Bot — Backtesting automático Polymarket
//  Funciona sin Claude, sin ordenador encendido (en servidor)
//  Guarda resultados en CSV + Google Sheets + PolyPaper
// ════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── CONFIGURACIÓN ────────────────────────────────────────────────
// Edita estos valores según tus preferencias
const CONFIG = {
  capital_virtual: 200,        // dinero ficticio que empiezas
  order_size: 30,              // cuánto pones por trade
  trailing_pct: 0.065,         // trailing stop 6.5%
  partial_pct: 0.50,           // cierra 50% en el primer objetivo
  stop_loss_pct: 0.15,         // stop loss 15% por debajo de entrada
  partial_target_pct: 0.25,    // cierre parcial +25% de la entrada
  min_volume_24h: 500000,      // mínimo $500K volumen 24h
  min_whale_consensus: 6,      // mínimo 6 de 10 whales coincidiendo
  csv_file: './resultados.csv',
  log_file: './bot.log',

  // Google Sheets (opcional — deja vacío si no lo usas)
  google_sheet_id: '',
  google_sheet_tab: 'PaperTrades',
};

// ── TIPOS DE EVENTO Y SU FRECUENCIA ─────────────────────────────
//
//  LENTO   → mercados Fed, elecciones, torneos largos
//            comprueba UNA VEZ AL DÍA a las 9:00
//
//  MEDIO   → partidos deportivos, datos macro
//            comprueba CADA 6 HORAS
//
//  RÁPIDO  → eventos con resolución en <24h
//            comprueba CADA HORA

const EVENT_TYPES = {
  slow:   { label: 'LENTO',  interval_hours: 24,  keywords: ['election','fed','world cup','champion','season','recession','president'] },
  medium: { label: 'MEDIO',  interval_hours: 6,   keywords: ['match','game','nfl','nba','ucl','final','playoff','cpi','earnings'] },
  fast:   { label: 'RÁPIDO', interval_hours: 1,   keywords: ['today','24h','hour','live','breaking','price','btc','eth'] },
};

// ── ESTADO EN MEMORIA ────────────────────────────────────────────
let state = {
  capital: CONFIG.capital_virtual,
  trades: [],    // posiciones abiertas
  closed: [],    // trades cerrados
  history: [],   // historial de capital
  last_check: {},// última vez que se chequeó cada mercado
};

// Carga estado guardado si existe
const STATE_FILE = './state.json';
if (fs.existsSync(STATE_FILE)) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch(e) { log('ERROR cargando estado: ' + e.message); }
}

// ── LOGGING ──────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.log_file, line + '\n'); } catch(e) {}
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch(e) { log('ERROR guardando estado: ' + e.message); }
}

// ── API POLYMARKET (gratuita, sin auth) ──────────────────────────
async function fetchMarkets() {
  try {
    const url = 'https://gamma-api.polymarket.com/markets?' +
      'active=true&closed=false&order=volume24hr&ascending=false&limit=30';
    const res = await fetch(url);
    if (!res.ok) throw new Error('API status ' + res.status);
    const data = await res.json();
    log(`✓ API Polymarket: ${data.length} mercados cargados`);
    return data;
  } catch(e) {
    log('ERROR API Polymarket: ' + e.message);
    return [];
  }
}

async function fetchMarketPriceHistory(slug) {
  try {
    const url = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch(e) { return null; }
}

// ── DETECTAR TIPO DE EVENTO ──────────────────────────────────────
function detectEventType(market) {
  const q = (market.question || '').toLowerCase();
  for (const [type, cfg] of Object.entries(EVENT_TYPES)) {
    if (cfg.keywords.some(k => q.includes(k))) return type;
  }
  return 'medium'; // por defecto
}

// ── CALCULAR SEÑAL DEL SISTEMA ───────────────────────────────────
function getSystemSignal(market) {
  const price = parseFloat((JSON.parse(market.outcomePrices || '["0.5"]'))[0] || 0.5);
  const vol   = parseFloat(market.volume24hr || 0);
  const liq   = parseFloat(market.liquidity || 0);

  // Filtro mínimo de volumen
  if (vol < CONFIG.min_volume_24h) return null;

  // Sistema VOLATILIDAD: precio en rango medio + alto volumen
  if (price >= 0.30 && price <= 0.68 && vol > 1000000) {
    return {
      system: 'volatility',
      label:  '⚡ VOLATILIDAD',
      entry:  price,
      stop:   parseFloat((price * (1 - CONFIG.stop_loss_pct)).toFixed(3)),
      partial: parseFloat((price * (1 + CONFIG.partial_target_pct)).toFixed(3)),
      reason: `Vol $${(vol/1e6).toFixed(1)}M, precio en rango medio $${price.toFixed(2)}`,
    };
  }

  // Sistema CONSENSO: precio alto (whales acumulando)
  if (price >= 0.65 && price <= 0.90 && vol > 500000) {
    return {
      system: 'consensus',
      label:  '🐋 CONSENSO',
      entry:  price,
      stop:   parseFloat((price * (1 - CONFIG.stop_loss_pct * 0.6)).toFixed(3)),
      partial: parseFloat(Math.min(0.98, price * 1.12).toFixed(3)),
      reason: `Precio alto $${price.toFixed(2)}, consenso probable`,
    };
  }

  return null;
}

// ── VERIFICAR SI ES HORA DE CHEQUEAR ─────────────────────────────
function shouldCheck(market) {
  const type     = detectEventType(market);
  const interval = EVENT_TYPES[type].interval_hours * 60 * 60 * 1000;
  const lastCheck = state.last_check[market.slug] || 0;
  return (Date.now() - lastCheck) >= interval;
}

// ── ABRIR TRADE PAPER ────────────────────────────────────────────
function openTrade(market, signal) {
  // No abrir si ya tenemos ese mercado abierto
  if (state.trades.find(t => t.slug === market.slug)) return;

  // No operar si no hay suficiente capital virtual
  if (state.capital < CONFIG.order_size) {
    log(`⚠ Capital insuficiente: $${state.capital.toFixed(2)}`);
    return;
  }

  const trade = {
    id:           Date.now(),
    slug:         market.slug,
    market:       market.question,
    system:       signal.system,
    event_type:   detectEventType(market),
    entry:        signal.entry,
    order:        CONFIG.order_size,
    stop:         signal.stop,
    partial:      signal.partial,
    trail_high:   signal.entry,
    trail_stop:   parseFloat((signal.entry * (1 - CONFIG.trailing_pct)).toFixed(4)),
    partial_done: false,
    current:      signal.entry,
    open_date:    new Date().toISOString(),
    reason:       signal.reason,
    volume_24h:   parseFloat(market.volume24hr || 0),
  };

  state.trades.push(trade);
  state.capital -= CONFIG.order_size;
  state.last_check[market.slug] = Date.now();
  saveState();

  log(`📥 TRADE ABIERTO: ${market.question.substring(0,50)}`);
  log(`   Sistema: ${signal.label} | Entrada: $${signal.entry} | Order: $${CONFIG.order_size}`);
  log(`   Stop: $${signal.stop} | Cierre50%: $${signal.partial} | Capital: $${state.capital.toFixed(2)}`);

  saveToCsv({
    type:        'OPEN',
    date:        new Date().toLocaleDateString('es-ES'),
    time:        new Date().toLocaleTimeString('es-ES'),
    market:      market.question,
    system:      signal.label,
    event_type:  EVENT_TYPES[detectEventType(market)].label,
    entry:       signal.entry,
    stop:        signal.stop,
    partial:     signal.partial,
    order:       CONFIG.order_size,
    capital:     state.capital.toFixed(2),
    reason:      signal.reason,
    pnl:         '',
    result:      'OPEN',
  });
}

// ── ACTUALIZAR TRADES ABIERTOS ────────────────────────────────────
function updateTrades(markets) {
  state.trades.forEach(trade => {
    const market = markets.find(m => m.slug === trade.slug);
    if (!market) return;

    const prices = JSON.parse(market.outcomePrices || '["0.5"]');
    const currentPrice = parseFloat(prices[0] || trade.current);
    trade.current = currentPrice;

    // Actualizar trailing stop
    if (currentPrice > trade.trail_high) {
      trade.trail_high = currentPrice;
      trade.trail_stop = parseFloat((currentPrice * (1 - CONFIG.trailing_pct)).toFixed(4));
    }

    // ── Chequear condiciones de cierre ──

    // 1. STOP LOSS duro
    if (currentPrice <= trade.stop) {
      closeTrade(trade, currentPrice, 'STOP_LOSS');
      return;
    }

    // 2. CIERRE PARCIAL (50%)
    if (!trade.partial_done && currentPrice >= trade.partial) {
      trade.partial_done = true;
      const shares      = (trade.order * CONFIG.partial_pct) / trade.entry;
      const proceeds    = shares * currentPrice * (1 - 0.02);
      const partial_pnl = proceeds - (trade.order * CONFIG.partial_pct);
      state.capital    += trade.order * CONFIG.partial_pct + partial_pnl;
      trade.order      *= (1 - CONFIG.partial_pct); // reduce order a la mitad

      log(`✂️  CIERRE 50%: ${trade.market.substring(0,40)}`);
      log(`   Precio: $${currentPrice} | PnL parcial: +$${partial_pnl.toFixed(2)}`);

      saveToCsv({
        type: 'PARTIAL', date: new Date().toLocaleDateString('es-ES'),
        time: new Date().toLocaleTimeString('es-ES'),
        market: trade.market, system: trade.system,
        event_type: EVENT_TYPES[trade.event_type]?.label || trade.event_type,
        entry: trade.entry, stop: trade.stop, partial: trade.partial,
        order: CONFIG.order_size * CONFIG.partial_pct,
        capital: state.capital.toFixed(2),
        reason: 'Cierre 50% en objetivo',
        pnl: partial_pnl.toFixed(2), result: 'PARTIAL',
      });
    }

    // 3. TRAILING STOP (solo si ya hicimos cierre parcial)
    if (trade.partial_done && currentPrice <= trade.trail_stop) {
      closeTrade(trade, currentPrice, 'TRAILING_STOP');
      return;
    }
  });

  saveState();
}

function closeTrade(trade, exitPrice, reason) {
  const idx = state.trades.findIndex(t => t.id === trade.id);
  if (idx === -1) return;

  const shares  = trade.order / trade.entry;
  const proceeds = shares * exitPrice * (1 - 0.02); // 2% fee
  const pnl     = proceeds - trade.order;
  const result  = pnl >= 0 ? 'WIN' : 'LOSS';

  state.capital += trade.order + pnl;
  state.history.push({ date: new Date().toISOString(), capital: state.capital });

  const closed = {
    ...trade,
    exit_price: exitPrice,
    exit_date:  new Date().toISOString(),
    pnl,
    result,
    close_reason: reason,
  };

  state.closed.push(closed);
  state.trades.splice(idx, 1);
  saveState();

  const emoji = pnl >= 0 ? '💰' : '🛑';
  log(`${emoji} TRADE CERRADO: ${trade.market.substring(0,40)}`);
  log(`   Razón: ${reason} | Exit: $${exitPrice} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  log(`   Capital virtual: $${state.capital.toFixed(2)}`);

  saveToCsv({
    type:       'CLOSE',
    date:       new Date().toLocaleDateString('es-ES'),
    time:       new Date().toLocaleTimeString('es-ES'),
    market:     trade.market,
    system:     trade.system,
    event_type: EVENT_TYPES[trade.event_type]?.label || trade.event_type,
    entry:      trade.entry,
    stop:       trade.stop,
    partial:    trade.partial,
    order:      trade.order,
    capital:    state.capital.toFixed(2),
    reason:     reason,
    pnl:        pnl.toFixed(2),
    result,
  });

  printStats();
}

// ── ESTADÍSTICAS ──────────────────────────────────────────────────
function printStats() {
  const wins   = state.closed.filter(t => t.result === 'WIN').length;
  const total  = state.closed.length;
  const wr     = total > 0 ? (wins / total * 100).toFixed(1) : 0;
  const pnl    = state.capital - CONFIG.capital_virtual;
  const roi    = (pnl / CONFIG.capital_virtual * 100).toFixed(1);

  log('─── ESTADÍSTICAS ───────────────────────────────');
  log(`Capital: $${state.capital.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ROI: ${roi}%`);
  log(`Trades cerrados: ${total} | Ganados: ${wins} | Win rate: ${wr}%`);
  log(`Trades abiertos: ${state.trades.length}`);
  log('────────────────────────────────────────────────');
}

// ── GUARDAR EN CSV ────────────────────────────────────────────────
function saveToCsv(row) {
  const headers = [
    'type','date','time','market','system','event_type',
    'entry','stop','partial','order','capital','reason','pnl','result'
  ];

  // Crear archivo con cabeceras si no existe
  if (!fs.existsSync(CONFIG.csv_file)) {
    fs.writeFileSync(CONFIG.csv_file, headers.join(',') + '\n');
  }

  const line = headers.map(h => {
    const val = String(row[h] || '').replace(/,/g, ';').replace(/\n/g, ' ');
    return `"${val}"`;
  }).join(',');

  fs.appendFileSync(CONFIG.csv_file, line + '\n');
}

// ── CICLO PRINCIPAL ───────────────────────────────────────────────
async function runCycle() {
  log('════ INICIO CICLO ══════════════════════════════');

  // 1. Cargar mercados reales de Polymarket
  const markets = await fetchMarkets();
  if (markets.length === 0) {
    log('⚠ Sin mercados — reintentando en próximo ciclo');
    return;
  }

  // 2. Actualizar precios de trades abiertos
  if (state.trades.length > 0) {
    log(`↻ Actualizando ${state.trades.length} trades abiertos...`);
    updateTrades(markets);
  }

  // 3. Buscar nuevas señales
  log('🔍 Buscando señales...');
  let signals_found = 0;

  for (const market of markets) {
    // Solo chequear si toca según el tipo de evento
    if (!shouldCheck(market)) continue;

    state.last_check[market.slug] = Date.now();
    const signal = getSystemSignal(market);
    if (!signal) continue;

    log(`📡 Señal detectada: ${market.question.substring(0,50)}`);
    log(`   ${signal.label} | Precio: $${signal.entry} | Vol: $${(parseFloat(market.volume24hr||0)/1e6).toFixed(1)}M`);

    openTrade(market, signal);
    signals_found++;
  }

  if (signals_found === 0) log('ℹ Sin señales nuevas en este ciclo');

  log(`════ FIN CICLO (${new Date().toLocaleTimeString('es-ES')}) ═══════════════════════`);
  printStats();
}

// ── ARRANCAR ──────────────────────────────────────────────────────
async function main() {
  log('🚀 PolyPaper Bot arrancado');
  log(`   Capital virtual: $${CONFIG.capital_virtual}`);
  log(`   Orden por trade: $${CONFIG.order_size}`);
  log(`   Trailing stop:   ${CONFIG.trailing_pct * 100}%`);
  log(`   Vol mínimo:      $${(CONFIG.min_volume_24h/1000).toFixed(0)}K`);
  log('');

  // Ciclo inmediato al arrancar
  await runCycle();

  // Ciclo cada 60 minutos — el bot decide internamente
  // si toca chequear cada mercado según su tipo (1h / 6h / 24h)
  setInterval(runCycle, 60 * 60 * 1000);

  log('⏰ Bot programado — ciclo cada 60 min');
  log('   (cada mercado se chequea según su tipo: 1h / 6h / 24h)');
}

main().catch(e => {
  log('ERROR FATAL: ' + e.message);
  process.exit(1);
});
