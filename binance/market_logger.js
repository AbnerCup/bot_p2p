/**
 * Módulo de Registro y Análisis de Comportamiento del Mercado P2P
 * Guarda el histórico continuo de precios, ofertas y cambios de competencia en CSV y JSON.
 */

const fs = require('fs');
const path = require('path');

const MARKET_CSV = path.join(__dirname, '../market_history.csv');
const MARKET_JSON = path.join(__dirname, '../market_history.json');

let lastLoggedState = null;
let lastLogTime = 0;

/**
 * Inicializa el archivo CSV con sus cabeceras si no existe
 */
function initMarketCSV() {
    if (!fs.existsSync(MARKET_CSV)) {
        const headers = [
            'Fecha_Hora',
            'Evento',
            'Top1_Compra',
            'Comerciante_Top1_Compra',
            'Compra_Popular',
            'Concurrencia_Compra',
            'Media_Compra',
            'Top1_Venta',
            'Comerciante_Top1_Venta',
            'Venta_Popular',
            'Media_Venta',
            'Spread_BOB',
            'Margen_Porcentaje'
        ].join(';');
        fs.writeFileSync(MARKET_CSV, headers + '\n', 'utf8');
    }
}

/**
 * Registra un snapshot o cambio relevante de mercado
 */
function logMarketChange(strategy, competitorBuyers = [], competitorSellers = []) {
    initMarketCSV();

    const now = new Date();
    const localTime = now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' });
    const nowMs = now.getTime();

    const topBuyer = competitorBuyers[0] || {};
    const topSeller = competitorSellers[0] || {};

    const currentState = {
        top1Buy: topBuyer.adv ? parseFloat(topBuyer.adv.price).toFixed(2) : strategy.suggestedBuyPrice,
        top1BuyMerchant: topBuyer.advertiser ? topBuyer.advertiser.nickName : 'N/A',
        popularBuy: strategy.suggestedBuyPrice,
        popularBuyCount: strategy.popularBuyCount || 1,
        mediaBuy: strategy.mediaBuy,
        top1Sell: topSeller.adv ? parseFloat(topSeller.adv.price).toFixed(2) : strategy.suggestedSellPrice,
        top1SellMerchant: topSeller.advertiser ? topSeller.advertiser.nickName : 'N/A',
        popularSell: strategy.suggestedSellPrice,
        mediaSell: strategy.mediaSell,
        spreadBob: (parseFloat(strategy.suggestedSellPrice) - parseFloat(strategy.suggestedBuyPrice)).toFixed(3),
        marginPercent: strategy.marginPercent
    };

    // Determinar si hubo un cambio real en las ofertas o si pasaron más de 60 segundos
    let eventType = 'SNAPSHOT_PERIODICO';
    let shouldLog = false;

    if (!lastLoggedState) {
        eventType = 'INICIO_MONITOREO';
        shouldLog = true;
    } else {
        const buyChanged = lastLoggedState.popularBuy !== currentState.popularBuy || lastLoggedState.top1Buy !== currentState.top1Buy;
        const sellChanged = lastLoggedState.popularSell !== currentState.popularSell || lastLoggedState.top1Sell !== currentState.top1Sell;
        const timeElapsed = nowMs - lastLogTime >= 30000; // Registro cada 30 seg mínimo

        if (buyChanged && sellChanged) {
            eventType = 'CAMBIO_GLOBAL_MERCADO';
            shouldLog = true;
        } else if (buyChanged) {
            eventType = 'CAMBIO_OFERTAS_COMPRA';
            shouldLog = true;
        } else if (sellChanged) {
            eventType = 'CAMBIO_OFERTAS_VENTA';
            shouldLog = true;
        } else if (timeElapsed) {
            eventType = 'RITMO_MERCADO';
            shouldLog = true;
        }
    }

    if (!shouldLog) return;

    lastLoggedState = currentState;
    lastLogTime = nowMs;

    // 1. Guardar en CSV para Excel
    const csvRow = [
        `"${localTime}"`,
        eventType,
        currentState.top1Buy,
        `"${currentState.top1BuyMerchant}"`,
        currentState.popularBuy,
        currentState.popularBuyCount,
        currentState.mediaBuy,
        currentState.top1Sell,
        `"${currentState.top1SellMerchant}"`,
        currentState.popularSell,
        currentState.mediaSell,
        currentState.spreadBob,
        `${currentState.marginPercent}%`
    ].join(';');

    fs.appendFileSync(MARKET_CSV, csvRow + '\n', 'utf8');

    // 2. Guardar en JSON estructurado
    let jsonHistory = [];
    if (fs.existsSync(MARKET_JSON)) {
        try {
            jsonHistory = JSON.parse(fs.readFileSync(MARKET_JSON, 'utf8'));
        } catch (e) {
            jsonHistory = [];
        }
    }

    jsonHistory.push({
        timestamp: now.toISOString(),
        localTime,
        eventType,
        ...currentState
    });

    // Mantener los últimos 20,000 registros para no sobrecargar el disco
    if (jsonHistory.length > 20000) {
        jsonHistory = jsonHistory.slice(-20000);
    }

    fs.writeFileSync(MARKET_JSON, JSON.stringify(jsonHistory, null, 2), 'utf8');
}

/**
 * Analiza el comportamiento del mercado a partir del histórico guardado
 */
function analyzeMarketHistory() {
    if (!fs.existsSync(MARKET_JSON)) {
        console.log('⚠️ Aún no hay datos de mercado guardados. Corre "npm run monitor" para recolectar datos.');
        return;
    }

    const history = JSON.parse(fs.readFileSync(MARKET_JSON, 'utf8'));
    if (history.length === 0) {
        console.log('⚠️ Historial de mercado vacío.');
        return;
    }

    console.log('\n=============================================================');
    console.log(' 📈 REPORTE DE COMPORTAMIENTO Y TENDENCIAS DEL MERCADO P2P');
    console.log('=============================================================\n');
    console.log(`- Muestras registradas: ${history.length} eventos.`);
    console.log(`- Desde: ${history[0].localTime}`);
    console.log(`- Hasta: ${history[history.length - 1].localTime}\n`);

    let minBuy = 9999, maxBuy = 0, sumBuy = 0;
    let minSell = 9999, maxSell = 0, sumSell = 0;
    let maxSpread = 0, bestSpreadEvent = null;

    history.forEach(item => {
        const b = parseFloat(item.popularBuy);
        const s = parseFloat(item.popularSell);
        const sp = parseFloat(item.spreadBob);

        if (b < minBuy) minBuy = b;
        if (b > maxBuy) maxBuy = b;
        sumBuy += b;

        if (s < minSell) minSell = s;
        if (s > maxSell) maxSell = s;
        sumSell += s;

        if (sp > maxSpread) {
            maxSpread = sp;
            bestSpreadEvent = item;
        }
    });

    const avgBuy = (sumBuy / history.length).toFixed(2);
    const avgSell = (sumSell / history.length).toFixed(2);
    const avgSpread = (avgSell - avgBuy).toFixed(2);

    console.log('📊 RANGOS DE PRECIOS DETECTADOS:');
    console.log(`🟢 Compra Mínima: ${minBuy} BOB | Compra Máxima: ${maxBuy} BOB | Promedio: ${avgBuy} BOB`);
    console.log(`🔴 Venta Mínima:   ${minSell} BOB | Venta Máxima:   ${maxSell} BOB | Promedio: ${avgSell} BOB`);
    console.log(`💰 Spread Promedio: ${avgSpread} BOB por USDT\n`);

    if (bestSpreadEvent) {
        console.log('⭐ MOMENTO DE MAYOR MARGEN REGISTRADO:');
        console.log(`- Hora:   ${bestSpreadEvent.localTime}`);
        console.log(`- Spread: +${bestSpreadEvent.spreadBob} BOB por USDT`);
        console.log(`- Compra: ${bestSpreadEvent.popularBuy} BOB | Venta: ${bestSpreadEvent.popularSell} BOB\n`);
    }

    console.log(`📁 Archivo CSV listo para abrir en Excel: market_history.csv`);
    console.log('=============================================================\n');
}

module.exports = {
    logMarketChange,
    analyzeMarketHistory,
    MARKET_CSV,
    MARKET_JSON
};
