// PolyPaper Bot - Bot de trading para Polymarket
const axios = require('axios');

// Configuración del bot (valores mejorados)
const CONFIG = {
    capitalInicial: 500,           // Empieza con $500
    ordenPorTrade: 15,              // Arriesga $15 por apuesta
    stopLossPorcentaje: 15,         // Stop loss del 15%
    takeProfitPorcentaje: 25,       // Take profit del 25%
    volumenMinimo: 500000,          // Volumen mínimo $500K
    cicloMinutos: 60,               // Revisar cada 60 minutos
};

let capital = CONFIG.capitalInicial;
let tradesAbiertos = [];
let tradesCerrados = [];
let totalPnL = 0;

// Función principal
async function ejecutarCiclo() {
    console.log(`\n═══ INICIO CICLO ═══`);
    console.log(`Capital: $${capital.toFixed(2)}`);
    
    try {
        // Obtener mercados de Polymarket
        const mercados = await obtenerMercados();
        
        // Buscar señal de trading
        const señal = buscarSeñal(mercados);
        
        if (señal && capital >= CONFIG.ordenPorTrade) {
            await abrirTrade(señal);
        }
        
        // Actualizar trades abiertos
        await actualizarTrades();
        
        // Mostrar estadísticas
        mostrarEstadisticas();
        
    } catch (error) {
        console.error("Error en ciclo:", error.message);
    }
    
    console.log(`═══ FIN CICLO ═══\n`);
}

// Obtener mercados de Polymarket
async function obtenerMercados() {
    try {
        const response = await axios.get('https://clob.polymarket.com/markets');
        const mercados = response.data || [];
        return mercados.filter(m => (m.volume24hr || 0) >= CONFIG.volumenMinimo);
    } catch (error) {
        console.log("⚠️ Error al obtener mercados");
        return [];
    }
}

// Buscar señal de trading
function buscarSeñal(mercados) {
    if (!mercados || mercados.length === 0) return null;
    
    for (const mercado of mercados) {
        const precio = parseFloat(mercado.price || mercado.clobToken?.price || 0.5);
        const volumen = parseFloat(mercado.volume24hr || mercado.volume || 0);
        
        // Señal: precio entre $0.30 y $0.70 (volatilidad alta)
        if (precio > 0.30 && precio < 0.70 && volumen >= CONFIG.volumenMinimo) {
            console.log(`📡 Señal detectada: ${mercado.question || mercado.title || "Mercado"}`);
            console.log(`   Precio: $${precio.toFixed(3)} | Vol: $${(volumen/1e6).toFixed(1)}M`);
            return { mercado, precio, volumen };
        }
    }
    return null;
}

// Abrir un nuevo trade
async function abrirTrade(señal) {
    const nombre = señal.mercado.question || señal.mercado.title || "Mercado";
    const orden = {
        id: Date.now(),
        mercado: nombre,
        entrada: señal.precio,
        cantidad: CONFIG.ordenPorTrade,
        stopLoss: señal.precio * (1 - CONFIG.stopLossPorcentaje / 100),
        takeProfit50: señal.precio * (1 + CONFIG.takeProfitPorcentaje / 100 / 2),
        takeProfit100: señal.precio * (1 + CONFIG.takeProfitPorcentaje / 100),
        fecha: new Date().toISOString(),
        estado: 'abierto',
        cerrado50: false
    };
    
    capital -= orden.cantidad;
    tradesAbiertos.push(orden);
    
    console.log(`📥 TRADE ABIERTO: ${orden.mercado.substring(0, 60)}`);
    console.log(`   Entrada: $${orden.entrada.toFixed(3)} | Orden: $${orden.cantidad}`);
    console.log(`   Stop: $${orden.stopLoss.toFixed(3)} | Take50%: $${orden.takeProfit50.toFixed(3)}`);
    console.log(`   Capital restante: $${capital.toFixed(2)}`);
}

// Actualizar trades abiertos
async function actualizarTrades() {
    for (let i = 0; i < tradesAbiertos.length; i++) {
        const trade = tradesAbiertos[i];
        
        // Simular precio actual (entre 0 y 1)
        const precioActual = Math.random();
        
        // Verificar stop loss
        if (precioActual <= trade.stopLoss) {
            const perdida = trade.cantidad * (1 - (precioActual / trade.entrada));
            totalPnL -= perdida;
            capital += trade.cantidad - perdida;
            tradesCerrados.push({ ...trade, estado: 'perdida', pnl: -perdida, salida: precioActual });
            tradesAbiertos.splice(i, 1);
            i--;
            console.log(`🛑 TRADE CERRADO (STOP LOSS): Salida: $${precioActual.toFixed(3)} | PnL: -$${perdida.toFixed(2)}`);
        }
        // Verificar take profit 50%
        else if (precioActual >= trade.takeProfit50 && !trade.cerrado50) {
            const ganancia = (trade.cantidad * 0.5) * (precioActual / trade.entrada - 1);
            totalPnL += ganancia;
            capital += (trade.cantidad * 0.5) + ganancia;
            trade.cantidad = trade.cantidad * 0.5;
            trade.cerrado50 = true;
            console.log(`✂️ CIERRE 50% (Take Profit): Precio: $${precioActual.toFixed(3)} | Ganancia parcial: +$${ganancia.toFixed(2)}`);
        }
        // Verificar take profit 100%
        else if (precioActual >= trade.takeProfit100 && trade.cerrado50) {
            const ganancia = trade.cantidad * (precioActual / trade.entrada - 1);
            totalPnL += ganancia;
            capital += trade.cantidad + ganancia;
            tradesCerrados.push({ ...trade, estado: 'ganancia', pnl: ganancia, salida: precioActual });
            tradesAbiertos.splice(i, 1);
            i--;
            console.log(`✅ TRADE CERRADO (Take Profit 100%): Salida: $${precioActual.toFixed(3)} | Ganancia: +$${ganancia.toFixed(2)}`);
        }
    }
}

// Mostrar estadísticas
function mostrarEstadisticas() {
    const ganados = tradesCerrados.filter(t => t.estado === 'ganancia').length;
    const perdidos = tradesCerrados.filter(t => t.estado === 'perdida').length;
    const roi = (totalPnL / CONFIG.capitalInicial) * 100;
    const winRate = tradesCerrados.length > 0 ? (ganados / tradesCerrados.length * 100) : 0;
    
    console.log(`\n─── ESTADÍSTICAS ───`);
    console.log(`Capital: $${capital.toFixed(2)} | PnL: $${totalPnL.toFixed(2)} | ROI: ${roi.toFixed(1)}%`);
    console.log(`Trades cerrados: ${tradesCerrados.length} | Ganados: ${ganados} | Perdidos: ${perdidos} | Win rate: ${winRate.toFixed(1)}%`);
    console.log(`Trades abiertos: ${tradesAbiertos.length}`);
    if (tradesAbiertos.length > 0) {
        console.log(`   Capital comprometido en trades abiertos: $${(CONFIG.capitalInicial - capital - totalPnL + capital).toFixed(2)}`);
    }
}

// Iniciar el bot
function iniciarBot() {
    console.log(`🚀 PolyPaper Bot arrancado`);
    console.log(`   Capital virtual: $${CONFIG.capitalInicial}`);
    console.log(`   Orden por trade: $${CONFIG.ordenPorTrade}`);
    console.log(`   Stop loss: ${CONFIG.stopLossPorcentaje}%`);
    console.log(`   Take profit: ${CONFIG.takeProfitPorcentaje}%`);
    console.log(`   Volumen mínimo: $${CONFIG.volumenMinimo/1000}K`);
    console.log(`   Ciclo: cada ${CONFIG.cicloMinutos} min\n`);
    
    // Ejecutar primer ciclo
    ejecutarCiclo();
    
    // Programar ciclos automáticos
    setInterval(ejecutarCiclo, CONFIG.cicloMinutos * 60 * 1000);
}

// Verificar que axios está instalado
try {
    require.resolve('axios');
    iniciarBot();
} catch (e) {
    console.error("❌ Error: Axios no está instalado. Ejecuta: npm install axios");
    process.exit(1);
}
