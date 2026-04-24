const axios = require('axios');
const fs = require('fs');

// ============================================
// CONFIGURACIÓN DEL BOT (¡CÁMBIALA AQUÍ!)
// ============================================
const CONFIG = {
    // Capital y riesgos
    CAPITAL_INICIAL: 500,           // $500 (puedes cambiarlo)
    RISK_PER_TRADE: 0.06,           // 6% del capital por trade (más seguro)
    MAX_OPEN_TRADES: 3,             // Máximo 3 trades abiertos
    
    // Filtros de mercado
    MIN_VOLUME: 500000,             // $500K mínimo de volumen
    PRICE_MIN: 0.30,                // Precio mínimo $0.30
    PRICE_MAX: 0.70,                // Precio máximo $0.70
    
    // Estrategia de ballenas
    TOP_TRADERS: 10,                // Analiza top 10 traders
    MIN_WHALES: 3,                  // Mínimo 3 ballenas para entrar
    
    // Gestión de riesgos
    STOP_LOSS: 0.10,                // Stop loss 10% (antes 6.5%)
    TAKE_PROFIT_PARTIAL: 0.15,      // Cierra 50% al +15%
    TRAILING_STOP: 0.05,            // Trailing stop 5%
    
    // Temporizadores
    CICLO_MINUTOS: 60,              // Revisa cada 60 minutos
};

// Variables del bot
let capital = CONFIG.CAPITAL_INICIAL;
let openTrades = [];
let closedTrades = [];
let totalPnL = 0;

// ============================================
// FUNCIONES PRINCIPALES
// ============================================

// Validar si un mercado es válido
function isValidMarket(market) {
    return (
        market.volume24h >= CONFIG.MIN_VOLUME &&
        market.price >= CONFIG.PRICE_MIN &&
        market.price <= CONFIG.PRICE_MAX
    );
}

// Verificar si hay consenso entre ballenas
function hasConsensus(trades, marketId) {
    const top = trades.slice(0, CONFIG.TOP_TRADERS);
    let count = 0;
    for (const trader of top) {
        if (trader.positions && trader.positions.includes(marketId)) {
            count++;
        }
    }
    return count >= CONFIG.MIN_WHALES;
}

// Calcular tamaño de la posición
function getPositionSize(capital) {
    return capital * CONFIG.RISK_PER_TRADE;
}

// Gestionar un trade abierto (stop loss, take profit, trailing)
function manageTrade(trade, currentPrice) {
    const pnl = (currentPrice - trade.entry) / trade.entry;
    
    // STOP LOSS
    if (pnl <= -CONFIG.STOP_LOSS) {
        const loss = trade.size * Math.abs(pnl);
        totalPnL -= loss;
        capital += trade.size - loss;
        closedTrades.push({ ...trade, status: 'loss', pnl: -loss, exitPrice: currentPrice });
        console.log(`🛑 STOP LOSS: ${trade.market} | Pérdida: -$${loss.toFixed(2)}`);
        return true; // Trade cerrado
    }
    
    // TAKE PROFIT PARCIAL (50%)
    if (pnl >= CONFIG.TAKE_PROFIT_PARTIAL && !trade.partialClosed) {
        const gain = (trade.size * 0.5) * pnl;
        totalPnL += gain;
        capital += (trade.size * 0.5) + gain;
        trade.size = trade.size * 0.5;
        trade.partialClosed = true;
        trade.trailingActive = true;
        trade.peak = currentPrice;
        console.log(`✂️ TAKE PROFIT 50%: ${trade.market} | Ganancia: +$${gain.toFixed(2)}`);
        return false; // Trade sigue abierto (mitad)
    }
    
    // TRAILING STOP (protege ganancias)
    if (trade.trailingActive) {
        if (currentPrice > trade.peak) {
            trade.peak = currentPrice;
        }
        const drop = (trade.peak - currentPrice) / trade.peak;
        if (drop >= CONFIG.TRAILING_STOP) {
            const gain = trade.size * ((currentPrice - trade.entry) / trade.entry);
            totalPnL += gain;
            capital += trade.size + gain;
            closedTrades.push({ ...trade, status: 'win', pnl: gain, exitPrice: currentPrice });
            console.log(`✅ TRAILING STOP: ${trade.market} | Ganancia: +$${gain.toFixed(2)}`);
            return true; // Trade cerrado
        }
    }
    
    return false; // Trade sigue abierto
}

// Abrir un nuevo trade
async function openTrade(market, price, size) {
    const trade = {
        id: Date.now(),
        market: market.title || market.question || "Mercado",
        entry: price,
        size: size,
        partialClosed: false,
        trailingActive: false,
        peak: price,
        openDate: new Date().toISOString()
    };
    
    capital -= size;
    openTrades.push(trade);
    
    console.log(`📥 TRADE ABIERTO: ${trade.market.substring(0, 50)}`);
    console.log(`   Entrada: $${price.toFixed(3)} | Tamaño: $${size.toFixed(2)}`);
    console.log(`   Stop Loss: ${CONFIG.STOP_LOSS * 100}% | Take Profit 50%: ${CONFIG.TAKE_PROFIT_PARTIAL * 100}%`);
    console.log(`   Capital restante: $${capital.toFixed(2)}`);
}

// Obtener datos de Polymarket (simulado)
async function getMarketData() {
    // Simulamos datos porque la API real necesita autenticación
    // En producción, usarías la API real de Polymarket
    return {
        markets: [
            { id: "1", title: "Will BTC close above $70k?", price: 0.55, volume24h: 1500000 },
            { id: "2", title: "Will ETH close above $4k?", price: 0.45, volume24h: 800000 },
            { id: "3", title: "Will SOL close above $200?", price: 0.65, volume24h: 600000 },
        ],
        traders: [
            { id: "whale1", positions: ["1", "2"] },
            { id: "whale2", positions: ["1"] },
            { id: "whale3", positions: ["1", "3"] },
            { id: "whale4", positions: ["2"] },
            { id: "whale5", positions: ["1", "2", "3"] },
        ]
    };
}

// Ejecutar ciclo principal
async function executeCycle() {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`🔄 CICLO INICIADO - ${new Date().toLocaleString()}`);
    console.log(`💰 Capital: $${capital.toFixed(2)}`);
    
    try {
        // Obtener datos del mercado
        const { markets, traders } = await getMarketData();
        
        // Buscar oportunidades
        for (const market of markets) {
            if (!isValidMarket(market)) continue;
            if (!hasConsensus(traders, market.id)) continue;
            if (openTrades.length >= CONFIG.MAX_OPEN_TRADES) {
                console.log(`⚠️ Máximo de trades abiertos alcanzado (${CONFIG.MAX_OPEN_TRADES})`);
                break;
            }
            
            const size = getPositionSize(capital);
            if (size > capital) {
                console.log(`⚠️ Capital insuficiente para abrir nuevo trade`);
                continue;
            }
            
            await openTrade(market, market.price, size);
        }
        
        // Gestionar trades abiertos (simular precios actuales)
        for (let i = 0; i < openTrades.length; i++) {
            const trade = openTrades[i];
            // Simular precio actual (entre 0 y 1)
            const currentPrice = Math.random();
            const closed = manageTrade(trade, currentPrice);
            if (closed) {
                openTrades.splice(i, 1);
                i--;
            }
        }
        
        // Mostrar estadísticas
        showStats();
        
    } catch (error) {
        console.error("❌ Error en ciclo:", error.message);
    }
    
    console.log(`${"=".repeat(50)}\n`);
}

// Mostrar estadísticas
function showStats() {
    const wins = closedTrades.filter(t => t.status === 'win').length;
    const losses = closedTrades.filter(t => t.status === 'loss').length;
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length * 100) : 0;
    const roi = (totalPnL / CONFIG.CAPITAL_INICIAL) * 100;
    
    console.log(`\n📊 ESTADÍSTICAS:`);
    console.log(`   Capital: $${capital.toFixed(2)} | PnL: $${totalPnL.toFixed(2)} | ROI: ${roi.toFixed(1)}%`);
    console.log(`   Trades cerrados: ${closedTrades.length} | Ganados: ${wins} | Perdidos: ${losses} | Win rate: ${winRate.toFixed(1)}%`);
    console.log(`   Trades abiertos: ${openTrades.length}`);
}

// Iniciar bot
function startBot() {
    console.log(`\n🚀 POLYPAPER BOT - ESTRATEGIA DE BALLENAS 🚀`);
    console.log(`💰 Capital inicial: $${CONFIG.CAPITAL_INICIAL}`);
    console.log(`🎲 Riesgo por trade: ${CONFIG.RISK_PER_TRADE * 100}%`);
    console.log(`🐋 Ballenas mínimas: ${CONFIG.MIN_WHALES} de ${CONFIG.TOP_TRADERS}`);
    console.log(`🛡️ Stop loss: ${CONFIG.STOP_LOSS * 100}% | Trailing: ${CONFIG.TRAILING_STOP * 100}%`);
    console.log(`🎯 Take profit parcial: ${CONFIG.TAKE_PROFIT_PARTIAL * 100}%`);
    console.log(`📊 Ciclo: cada ${CONFIG.CICLO_MINUTOS} minutos\n`);
    
    // Ejecutar primer ciclo
    executeCycle();
    
    // Programar ciclos automáticos
    setInterval(executeCycle, CONFIG.CICLO_MINUTOS * 60 * 1000);
}

// Iniciar
startBot();
