const axios = require('axios');
const fs = require('fs');

// ============================================
// CONFIGURACIÓN - CAMBIA ESTOS NÚMEROS SI QUIERES
// ============================================
const CONFIG = {
    CAPITAL_INICIAL: 500,        
    APUESTA_POR_TRADE: 15,       
    STOP_LOSS: 0.12,             
    MIN_VOLUMEN: 500000,         
    MAX_TRADES_ABIERTOS: 3,      
    CICLO_MINUTOS: 60,           
};

let capital = CONFIG.CAPITAL_INICIAL;
let tradesAbiertos = [];
let tradesCerrados = [];
let historial = [];

// ============================================
// OBTENER DATOS REALES DE POLYMARKET
// ============================================
async function obtenerMercados() {
    try {
        const response = await axios.get('https://gamma-api.polymarket.com/markets', {
            params: { limit: 50, closed: false, order: 'volume24hr' }
        });
        console.log(`✅ Cargados ${response.data.length} mercados reales`);
        return response.data;
    } catch (error) {
        console.log("❌ Error al obtener mercados:", error.message);
        return [];
    }
}

// ============================================
// BUSCAR SEÑAL DE TRADING
// ============================================
function buscarSeñal(mercados) {
    for (const m of mercados) {
        const precio = parseFloat(m.price) || 0.5;
        const volumen = parseFloat(m.volume24hr) || 0;
        const liquidez = parseFloat(m.liquidity) || 0;
        
        if (precio > 0.30 && precio < 0.70 && volumen >= CONFIG.MIN_VOLUMEN && liquidez > 10000) {
            return {
                id: m.id,
                pregunta: m.question || m.title || "Mercado",
                precio: precio,
                volumen: volumen,
                apostarYES: precio < 0.5
            };
        }
    }
    return null;
}

// ============================================
// SIMULAR APERTURA DE TRADE
// ============================================
function abrirTrade(señal) {
    if (tradesAbiertos.length >= CONFIG.MAX_TRADES_ABIERTOS) {
        console.log(`⚠️ Máximo de trades abiertos: ${CONFIG.MAX_TRADES_ABIERTOS}`);
        return;
    }
    
    if (capital < CONFIG.APUESTA_POR_TRADE) {
        console.log(`⚠️ Capital insuficiente: $${capital.toFixed(2)}`);
        return;
    }
    
    const trade = {
        id: Date.now(),
        pregunta: señal.pregunta,
        entrada: señal.precio,
        direccion: señal.apostarYES ? "YES" : "NO",
        cantidad: CONFIG.APUESTA_POR_TRADE,
        stopLoss: señal.apostarYES ? señal.precio * 0.88 : señal.precio * 1.12,
        fecha: new Date().toISOString()
    };
    
    capital -= trade.cantidad;
    tradesAbiertos.push(trade);
    
    historial.push({
        tipo: "APERTURA",
        fecha: trade.fecha,
        pregunta: trade.pregunta.substring(0, 50),
        direccion: trade.direccion,
        entrada: trade.entrada,
        cantidad: trade.cantidad,
        capital: capital
    });
    
    console.log(`📥 APUESTA: ${trade.pregunta.substring(0, 45)}`);
    console.log(`   ${trade.direccion} @ $${trade.entrada.toFixed(3)} | $${trade.cantidad}`);
}

// ============================================
// SIMULAR CIERRE DE TRADES
// ============================================
async function actualizarTrades(mercados) {
    for (let i = 0; i < tradesAbiertos.length; i++) {
        const t = tradesAbiertos[i];
        
        const mercadoActual = mercados.find(m => 
            (m.question && m.question.includes(t.pregunta.substring(0, 30))) ||
            (m.title && m.title.includes(t.pregunta.substring(0, 30)))
        );
        
        let precioActual = t.entrada;
        if (mercadoActual) precioActual = parseFloat(mercadoActual.price) || t.entrada;
        else precioActual = t.entrada * (0.97 + Math.random() * 0.06);
        
        let pnl = 0;
        let cerrado = false;
        let razon = "";
        
        if (t.direccion === "YES") {
            pnl = t.cantidad * ((precioActual - t.entrada) / t.entrada);
            if (precioActual <= t.stopLoss) { cerrado = true; razon = "STOP_LOSS"; pnl = -t.cantidad * 0.12; }
            else if (precioActual >= t.entrada * 1.20) { cerrado = true; razon = "TAKE_PROFIT"; pnl = t.cantidad * 0.20; }
        } else {
            pnl = t.cantidad * ((t.entrada - precioActual) / t.entrada);
            if (precioActual >= t.stopLoss) { cerrado = true; razon = "STOP_LOSS"; pnl = -t.cantidad * 0.12; }
            else if (precioActual <= t.entrada * 0.80) { cerrado = true; razon = "TAKE_PROFIT"; pnl = t.cantidad * 0.20; }
        }
        
        if (cerrado) {
            capital += t.cantidad + pnl;
            tradesCerrados.push({ ...t, pnl, razon, salida: precioActual, fechaCierre: new Date().toISOString() });
            tradesAbiertos.splice(i, 1);
            i--;
            
            historial.push({
                tipo: "CIERRE",
                fecha: new Date().toISOString(),
                pregunta: t.pregunta.substring(0, 50),
                razon: razon,
                pnl: pnl,
                capital: capital
            });
            
            console.log(`🛑 ${razon}: ${t.pregunta.substring(0, 35)} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        }
    }
}

// ============================================
// GUARDAR RESULTADOS EN CSV
// ============================================
function guardarCSV() {
    const ganados = tradesCerrados.filter(t => t.pnl > 0).length;
    const perdidos = tradesCerrados.filter(t => t.pnl <= 0).length;
    const pnlTotal = tradesCerrados.reduce((s, t) => s + t.pnl, 0);
    const roi = ((pnlTotal) / CONFIG.CAPITAL_INICIAL) * 100;
    
    let csv = "Fecha,Tipo,Pregunta,Dirección,Entrada,Salida,Cantidad,PnL,Capital,Razón\n";
    
    for (const e of historial) {
        if (e.tipo === "APERTURA") {
            csv += `${e.fecha},APERTURA,"${e.pregunta}",${e.direccion},${e.entrada.toFixed(3)},-,${e.cantidad},-,${e.capital},-\n`;
        } else {
            const trade = tradesCerrados.find(t => t.fecha === e.fecha);
            csv += `${e.fecha},CIERRE,"${e.pregunta}",${trade?.direccion || "-"},${trade?.entrada.toFixed(3) || "-"},${trade?.salida.toFixed(3) || "-"},${trade?.cantidad || "-"},${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)},${e.capital},${e.razon}\n`;
        }
    }
    
    csv += `\n--- RESUMEN ---\n`;
    csv += `Capital Inicial,${CONFIG.CAPITAL_INICIAL}\n`;
    csv += `Capital Final,${(CONFIG.CAPITAL_INICIAL + pnlTotal).toFixed(2)}\n`;
    csv += `PnL Total,${pnlTotal.toFixed(2)}\n`;
    csv += `ROI,${roi.toFixed(1)}%\n`;
    csv += `Trades Totales,${tradesCerrados.length}\n`;
    csv += `Ganados,${ganados}\n`;
    csv += `Perdidos,${perdidos}\n`;
    csv += `Win Rate,${tradesCerrados.length > 0 ? (ganados/tradesCerrados.length*100).toFixed(1) : 0}%\n`;
    
    fs.writeFileSync('simulacion.csv', csv);
    console.log(`📁 Resultados guardados en simulacion.csv`);
}

// ============================================
// CICLO PRINCIPAL
// ============================================
async function ciclo() {
    console.log(`\n${"=".repeat(45)}`);
    console.log(`🔄 CICLO - ${new Date().toLocaleString()}`);
    console.log(`💰 Capital: $${capital.toFixed(2)}`);
    
    const mercados = await obtenerMercados();
    if (mercados.length === 0) return;
    
    const señal = buscarSeñal(mercados);
    if (señal) {
        console.log(`📡 SEÑAL: ${señal.pregunta.substring(0, 45)}`);
        console.log(`   Precio: $${señal.precio.toFixed(3)} | Vol: $${(señal.volumen/1e6).toFixed(1)}M`);
        abrirTrade(señal);
    } else {
        console.log(`ℹ️ Sin señal en este ciclo`);
    }
    
    await actualizarTrades(mercados);
    
    const pnlTotal = tradesCerrados.reduce((s, t) => s + t.pnl, 0);
    console.log(`📊 PnL Total: $${pnlTotal.toFixed(2)} | ROI: ${((pnlTotal/CONFIG.CAPITAL_INICIAL)*100).toFixed(1)}%`);
    console.log(`   Abiertos: ${tradesAbiertos.length} | Cerrados: ${tradesCerrados.length}`);
    
    guardarCSV();
}

// ============================================
// INICIAR BOT
// ============================================
async function iniciar() {
    console.log(`\n🚀 BOT DE SIMULACIÓN - DATOS REALES POLYMARKET 🚀`);
    console.log(`💰 Capital: $${CONFIG.CAPITAL_INICIAL}`);
    console.log(`🎲 Apuesta: $${CONFIG.APUESTA_POR_TRADE}`);
    console.log(`🛡️ Stop Loss: ${CONFIG.STOP_LOSS*100}%`);
    console.log(`📊 Ciclo: cada ${CONFIG.CICLO_MINUTOS} min\n`);
    
    await ciclo();
    setInterval(ciclo, CONFIG.CICLO_MINUTOS * 60 * 1000);
}

iniciar();
