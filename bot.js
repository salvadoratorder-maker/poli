const axios = require('axios');
const fs = require('fs');

const CONFIG = {
    capitalInicial: 500,
    ordenPorTrade: 15,
    stopLossPorcentaje: 15,
    takeProfitPorcentaje: 25,
    volumenMinimo: 500000,
    cicloMinutos: 60,
};

let capital = CONFIG.capitalInicial;
let tradesAbiertos = [];
let tradesCerrados = [];
let totalPnL = 0;

async function obtenerMercados() {
    try {
        const response = await axios.get('https://polymarket.com/markets.json');
        return response.data || [];
    } catch (error) {
        console.log("⚠️ Error obteniendo mercados");
        return [];
    }
}

function buscarSeñal(mercados) {
    for (const m of mercados) {
        const precio = parseFloat(m.price) || 0.5;
        const volumen = parseFloat(m.volume) || 0;
        if (precio > 0.30 && precio < 0.70 && volumen >= CONFIG.volumenMinimo) {
            return { mercado: m, precio, volumen };
        }
    }
    return null;
}

async function abrirTrade(señal) {
    const orden = {
        id: Date.now(),
        mercado: señal.mercado.title || "Mercado",
        entrada: señal.precio,
        cantidad: CONFIG.ordenPorTrade,
        stopLoss: señal.precio * 0.85,
        takeProfit50: señal.precio * 1.125,
        fecha: new Date().toISOString(),
        cerrado50: false
    };
    capital -= orden.cantidad;
    tradesAbiertos.push(orden);
    console.log(`📥 TRADE: ${orden.mercado} | Entrada: $${orden.entrada.toFixed(3)} | $${orden.cantidad}`);
}

async function actualizarTrades() {
    for (let i = 0; i < tradesAbiertos.length; i++) {
        const t = tradesAbiertos[i];
        const precioActual = Math.random();
        
        if (precioActual <= t.stopLoss) {
            const perdida = t.cantidad * 0.85;
            totalPnL -= perdida;
            capital += t.cantidad - perdida;
            tradesCerrados.push({ ...t, estado: 'perdida' });
            tradesAbiertos.splice(i, 1);
            i--;
            console.log(`🛑 STOP LOSS: -$${perdida.toFixed(2)}`);
        }
        else if (precioActual >= t.takeProfit50 && !t.cerrado50) {
            const ganancia = t.cantidad * 0.5 * 0.15;
            totalPnL += ganancia;
            capital += t.cantidad * 0.5 + ganancia;
            t.cantidad *= 0.5;
            t.cerrado50 = true;
            console.log(`✅ CIERRE 50%: +$${ganancia.toFixed(2)}`);
        }
    }
}

function mostrarEstadisticas() {
    const ganados = tradesCerrados.filter(t => t.estado === 'ganancia').length;
    const roi = (totalPnL / CONFIG.capitalInicial) * 100;
    console.log(`\n📊 Capital: $${capital.toFixed(2)} | PnL: $${totalPnL.toFixed(2)} | ROI: ${roi.toFixed(1)}%`);
    console.log(`   Trades: ${tradesCerrados.length} | Ganados: ${ganados} | Abiertos: ${tradesAbiertos.length}\n`);
}

async function ejecutarCiclo() {
    console.log(`\n═══ CICLO ═══`);
    const mercados = await obtenerMercados();
    const señal = buscarSeñal(mercados);
    if (señal && capital >= CONFIG.ordenPorTrade) await abrirTrade(señal);
    await actualizarTrades();
    mostrarEstadisticas();
    console.log(`═══ FIN ═══\n`);
}

function iniciarBot() {
    console.log(`🚀 BOT INICIADO`);
    console.log(`💰 Capital: $${CONFIG.capitalInicial}`);
    console.log(`🎲 Apuesta: $${CONFIG.ordenPorTrade}`);
    console.log(`🛡️ Stop Loss: ${CONFIG.stopLossPorcentaje}%\n`);
    ejecutarCiclo();
    setInterval(ejecutarCiclo, CONFIG.cicloMinutos * 60 * 1000);
}

try { require.resolve('axios'); iniciarBot(); } 
catch(e) { console.log("❌ Instala axios: npm install axios"); }
