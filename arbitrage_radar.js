/**
 * RADAR CAZADOR DE BRECHAS DE ARBITRAJE CRUZADO: BINANCE ⇆ BYBIT P2P
 * 
 * Monitorea simultáneamente las puntas de compra y venta de Binance P2P y Bybit P2P (BOB/USDT),
 * detecta brechas de precio y calcula la GANANCIA NETA REAL deduciendo la comisión de retiro
 * estándar plana de Binance ($0.19 a $0.29 USDT por transacción) y de Bybit.
 * 
 * Rutas analizadas:
 * 1. [BINANCE ➔ BYBIT]: Comprar USDT en Binance P2P ➔ Mover a Bybit ➔ Vender USDT en Bybit P2P.
 * 2. [BYBIT ➔ BINANCE]: Comprar USDT en Bybit P2P ➔ Mover a Binance ➔ Vender USDT en Binance P2P.
 * 
 * Parámetros CLI soportados:
 *   --amount <USDT>       : Monto en USDT para simular la operación (default: 100 USDT)
 *   --fee <USDT>          : Comisión plana de retiro Binance (default: 0.29 USDT, e.g. 0.19 a 0.29)
 *   --bybit-fee <USDT>    : Comisión plana de retiro Bybit (default: 0.30 USDT)
 *   --min-profit <BOB>    : Ganancia neta mínima en BOB para sonar alarma (default: 0.10 BOB)
 *   --interval <ms>       : Intervalo de escaneo en milisegundos (default: 1000ms)
 *   --fast                : Escaneo rápido (400ms)
 *   --slow                : Modo ahorro (2500ms)
 *   --strict              : Mostrar únicamente oportunidades con límites 100% compatibles
 *   --once                : Ejecutar un solo escaneo y salir
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchBinanceP2P } = require('./binance/market');
const { fetchBybitP2P } = require('./bybit/market');
const { playAlertSound, toggleSoundMute, isSoundMuted } = require('./utils/sound');
const { loadIgnoredMerchants } = require('./bybit/eligibility');
const { filterIgnoredMerchants: filterIgnoredBinance } = require('./binance/eligibility');

// Archivos de historial
const HISTORY_CSV = path.join(__dirname, 'cross_arbitrage_history.csv');
const HISTORY_JSON = path.join(__dirname, 'cross_arbitrage_history.json');

// Parseo de argumentos CLI
const args = process.argv.slice(2);

function getArgValue(flags, defaultVal) {
    for (const flag of flags) {
        const idx = args.indexOf(flag);
        if (idx !== -1 && args[idx + 1] !== undefined) {
            return args[idx + 1];
        }
        const eqPrefix = flag + '=';
        const eqArg = args.find(a => a.startsWith(eqPrefix));
        if (eqArg) {
            return eqArg.slice(eqPrefix.length);
        }
    }
    return defaultVal;
}

let SIMULATED_AMOUNT_USDT = parseFloat(getArgValue(['--amount', '-a'], '100')) || 100;
let BINANCE_WITHDRAWAL_FEE = parseFloat(getArgValue(['--fee', '-f'], '0.29')) || 0.29;
let BYBIT_WITHDRAWAL_FEE = parseFloat(getArgValue(['--bybit-fee'], '0.30')) || 0.30;
let MIN_NET_PROFIT_BOB = parseFloat(getArgValue(['--min-profit', '-p'], '0.10')) || 0.10;
let ONLY_COMPATIBLE = args.includes('--strict') || args.includes('--only-compatible');
const RUN_ONCE = args.includes('--once');

let REFRESH_INTERVAL_MS = 1000;
if (args.includes('--fast')) {
    REFRESH_INTERVAL_MS = 400;
} else if (args.includes('--slow')) {
    REFRESH_INTERVAL_MS = 2500;
} else {
    const customInt = getArgValue(['--interval', '-i'], null);
    if (customInt && !isNaN(parseInt(customInt, 10))) {
        REFRESH_INTERVAL_MS = parseInt(customInt, 10);
    }
}

// Estado en memoria
let isPaused = false;
let scanCount = 0;
let opportunitiesFound = 0;
let lastLoggedGapKey = null;
let lastLoggedTime = 0;
let lastSoundAlertTime = 0;

// Inicializar cabecera CSV si no existe
function initHistoryCSV() {
    const headers = [
        'Fecha_Hora',
        'Ruta',
        'Plataforma_Compra',
        'Vendedor',
        'Precio_Compra_BOB',
        'Plataforma_Venta',
        'Comprador',
        'Precio_Venta_BOB',
        'Spread_Bruto_BOB',
        'Monto_Operado_USDT',
        'Comision_Retiro_USDT',
        'Costo_Comision_BOB',
        'Ganancia_Neta_BOB',
        'Ganancia_Neta_USDT',
        'Margen_Neto_Pct',
        'Limites_Compra_BOB',
        'Limites_Venta_BOB',
        'Compatibilidad_Limites',
        'Detalle'
    ].join(';');

    if (!fs.existsSync(HISTORY_CSV)) {
        fs.writeFileSync(HISTORY_CSV, headers + '\n', 'utf8');
    }
}

/**
 * Normaliza los anuncios de Binance al formato unificado de análisis
 */
function normalizeBinanceAds(rawBuyAds = [], rawSellAds = []) {
    // rawBuyAds: Anuncios tradeType 'BUY' -> Vendedores de USDT (donde nosotros COMPRAMOS como Takers)
    const sellers = (rawBuyAds || []).map(item => {
        const adv = item.adv || {};
        const p = parseFloat(adv.price || 0);
        const minB = parseFloat(adv.minSingleTransAmount || 0);
        const maxB = parseFloat(adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount || 0);
        const availU = parseFloat(adv.tradableQuantity || adv.surplusAmount || 0);
        return {
            platform: 'Binance',
            type: 'BUY_FROM_SELLER',
            nickName: item.advertiser?.nickName || 'Vendedor_Binance',
            userNo: item.advertiser?.userNo || '',
            price: p,
            minBob: minB,
            maxBob: maxB,
            availUsdt: availU,
            minUsdt: p > 0 ? minB / p : 0,
            maxUsdt: p > 0 ? Math.min(maxB / p, availU > 0 ? availU : maxB / p) : 0,
            methods: (adv.tradeMethods || []).map(m => m.tradeMethodName).join(', ')
        };
    }).filter(x => x.price > 0);

    // rawSellAds: Anuncios tradeType 'SELL' -> Compradores de USDT (donde nosotros VENDEMOS como Takers)
    const buyers = (rawSellAds || []).map(item => {
        const adv = item.adv || {};
        const p = parseFloat(adv.price || 0);
        const minB = parseFloat(adv.minSingleTransAmount || 0);
        const maxB = parseFloat(adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount || 0);
        const availU = parseFloat(adv.tradableQuantity || adv.surplusAmount || 0);
        return {
            platform: 'Binance',
            type: 'SELL_TO_BUYER',
            nickName: item.advertiser?.nickName || 'Comprador_Binance',
            userNo: item.advertiser?.userNo || '',
            price: p,
            minBob: minB,
            maxBob: maxB,
            availUsdt: availU,
            minUsdt: p > 0 ? minB / p : 0,
            maxUsdt: p > 0 ? Math.min(maxB / p, availU > 0 ? availU : maxB / p) : 0,
            methods: (adv.tradeMethods || []).map(m => m.tradeMethodName).join(', ')
        };
    }).filter(x => x.price > 0);

    return { sellers, buyers };
}

/**
 * Normaliza los anuncios de Bybit al formato unificado de análisis
 */
function normalizeBybitAds(rawSide1Ads = [], rawSide0Ads = []) {
    // rawSide1Ads: Anuncios side '1' -> Vendedores de USDT (donde nosotros COMPRAMOS como Takers)
    const sellers = (rawSide1Ads || []).map(item => {
        const p = parseFloat(item.price || 0);
        const minB = parseFloat(item.minAmount || 0);
        const maxB = parseFloat(item.maxAmount || 0);
        const availU = parseFloat(item.lastQuantity || 0);
        return {
            platform: 'Bybit',
            type: 'BUY_FROM_SELLER',
            nickName: item.nickName || 'Vendedor_Bybit',
            userId: item.userId || '',
            price: p,
            minBob: minB,
            maxBob: maxB,
            availUsdt: availU,
            minUsdt: p > 0 ? minB / p : 0,
            maxUsdt: p > 0 ? Math.min(maxB / p, availU > 0 ? availU : maxB / p) : 0,
            methods: (item.payments || []).join(', ')
        };
    }).filter(x => x.price > 0);

    // rawSide0Ads: Anuncios side '0' -> Compradores de USDT (donde nosotros VENDEMOS como Takers)
    const buyers = (rawSide0Ads || []).map(item => {
        const p = parseFloat(item.price || 0);
        const minB = parseFloat(item.minAmount || 0);
        const maxB = parseFloat(item.maxAmount || 0);
        const availU = parseFloat(item.lastQuantity || 0);
        return {
            platform: 'Bybit',
            type: 'SELL_TO_BUYER',
            nickName: item.nickName || 'Comprador_Bybit',
            userId: item.userId || '',
            price: p,
            minBob: minB,
            maxBob: maxB,
            availUsdt: availU,
            minUsdt: p > 0 ? minB / p : 0,
            maxUsdt: p > 0 ? Math.min(maxB / p, availU > 0 ? availU : maxB / p) : 0,
            methods: (item.payments || []).join(', ')
        };
    }).filter(x => x.price > 0);

    const ignored = loadIgnoredMerchants();
    const cleanSellers = ignored.length > 0 ? sellers.filter(s => !ignored.includes(s.nickName.toUpperCase())) : sellers;
    const cleanBuyers = ignored.length > 0 ? buyers.filter(b => !ignored.includes(b.nickName.toUpperCase())) : buyers;

    return { sellers: cleanSellers, buyers: cleanBuyers };
}

/**
 * Evalúa compatibilidad de límites entre el anuncio de compra y el de venta
 */
function checkLimitCompatibility(buyAd, sellAd, testAmountUsdt) {
    const buyMinU = buyAd.minUsdt;
    const buyMaxU = buyAd.maxUsdt;
    const sellMinU = sellAd.minUsdt;
    const sellMaxU = sellAd.maxUsdt;

    const overlapMinUsdt = Math.max(buyMinU, sellMinU);
    const overlapMaxUsdt = Math.min(buyMaxU, sellMaxU);
    const hasOverlap = overlapMaxUsdt >= overlapMinUsdt && overlapMaxUsdt > 0;

    let isAmountEligible = false;
    let note = '';

    if (hasOverlap) {
        if (testAmountUsdt >= overlapMinUsdt && testAmountUsdt <= overlapMaxUsdt) {
            isAmountEligible = true;
            note = `Compatible para ${testAmountUsdt.toFixed(1)} USDT (Rango: ${overlapMinUsdt.toFixed(1)} - ${overlapMaxUsdt.toFixed(1)} USDT)`;
        } else if (testAmountUsdt < overlapMinUsdt) {
            note = `Monto ${testAmountUsdt} USDT menor al mínimo requerido de ${overlapMinUsdt.toFixed(1)} USDT (${(overlapMinUsdt * buyAd.price).toFixed(0)} BOB)`;
        } else {
            note = `Monto ${testAmountUsdt} USDT excede el máximo disponible de ${overlapMaxUsdt.toFixed(1)} USDT (${(overlapMaxUsdt * buyAd.price).toFixed(0)} BOB)`;
        }
    } else {
        if (buyMaxU < sellMinU) {
            note = `Incompatible: Vendedor ofrece máx ${buyMaxU.toFixed(1)} USDT, pero Comprador exige mín ${sellMinU.toFixed(1)} USDT`;
        } else if (sellMaxU < buyMinU) {
            note = `Incompatible: Comprador acepta máx ${sellMaxU.toFixed(1)} USDT, pero Vendedor exige mín ${buyMinU.toFixed(1)} USDT`;
        } else {
            note = 'Límites sin solapamiento';
        }
    }

    return {
        hasOverlap,
        isAmountEligible,
        overlapMinUsdt,
        overlapMaxUsdt,
        note
    };
}

/**
 * Calcula la rentabilidad exacta de una brecha de arbitraje
 */
function evaluateArbitrageOpportunity({
    route,
    buyAd,
    sellAd,
    amountUsdt,
    withdrawalFeeUsdt
}) {
    const buyPrice = buyAd.price;
    const sellPrice = sellAd.price;
    const grossSpread = parseFloat((sellPrice - buyPrice).toFixed(3));

    const fiatSpentBob = amountUsdt * buyPrice;
    const netCryptoReceived = Math.max(0, amountUsdt - withdrawalFeeUsdt);
    const fiatReceivedBob = netCryptoReceived * sellPrice;

    const netProfitBob = parseFloat((fiatReceivedBob - fiatSpentBob).toFixed(2));
    const netProfitUsdt = parseFloat((netProfitBob / buyPrice).toFixed(2));
    const netMarginPercent = fiatSpentBob > 0 ? parseFloat(((netProfitBob / fiatSpentBob) * 100).toFixed(2)) : 0;

    // Costo en BOB de la comisión de retiro
    const feeCostBob = parseFloat((withdrawalFeeUsdt * sellPrice).toFixed(2));

    // Spread mínimo en BOB necesario para que la operación cubra la comisión fija (Break-even)
    const breakEvenSpreadBob = parseFloat(((withdrawalFeeUsdt * sellPrice) / amountUsdt).toFixed(3));

    const limits = checkLimitCompatibility(buyAd, sellAd, amountUsdt);

    return {
        route, // 'BINANCE ➔ BYBIT' o 'BYBIT ➔ BINANCE'
        buyPlatform: buyAd.platform,
        sellPlatform: sellAd.platform,
        seller: buyAd,
        buyer: sellAd,
        buyPrice,
        sellPrice,
        grossSpread,
        amountUsdt,
        withdrawalFeeUsdt,
        feeCostBob,
        breakEvenSpreadBob,
        fiatSpentBob: parseFloat(fiatSpentBob.toFixed(2)),
        fiatReceivedBob: parseFloat(fiatReceivedBob.toFixed(2)),
        netProfitBob,
        netProfitUsdt,
        netMarginPercent,
        limits,
        isProfitable: netProfitBob > 0
    };
}

/**
 * Escanea y compara ambas plataformas
 */
function findCrossArbitrageOpportunities(binanceData, bybitData, amountUsdt, binanceFee, bybitFee) {
    const opportunities = [];

    // RUTA 1: Comprar en Binance ➔ Transferir a Bybit ➔ Vender en Bybit
    // (Deduce la comisión fija de retiro de Binance: $0.19 a $0.29 USDT)
    for (const sellerBin of (binanceData.sellers || []).slice(0, 5)) {
        for (const buyerByb of (bybitData.buyers || []).slice(0, 5)) {
            const opp = evaluateArbitrageOpportunity({
                route: 'BINANCE ➔ BYBIT',
                buyAd: sellerBin,
                sellAd: buyerByb,
                amountUsdt,
                withdrawalFeeUsdt: binanceFee
            });
            opportunities.push(opp);
        }
    }

    // RUTA 2: Comprar en Bybit ➔ Transferir a Binance ➔ Vender en Binance
    // (Deduce la comisión fija de retiro de Bybit)
    for (const sellerByb of (bybitData.sellers || []).slice(0, 5)) {
        for (const buyerBin of (binanceData.buyers || []).slice(0, 5)) {
            const opp = evaluateArbitrageOpportunity({
                route: 'BYBIT ➔ BINANCE',
                buyAd: sellerByb,
                sellAd: buyerBin,
                amountUsdt,
                withdrawalFeeUsdt: bybitFee
            });
            opportunities.push(opp);
        }
    }

    // Ordenar por ganancia neta en BOB descendente
    opportunities.sort((a, b) => b.netProfitBob - a.netProfitBob);

    return opportunities;
}

/**
 * Guarda las oportunidades detectadas en CSV y JSON
 */
function logOpportunityToHistory(opp) {
    initHistoryCSV();
    const now = new Date();
    const dateStr = now.toLocaleString('es-BO', { timeZone: 'America/La_Paz' });

    // Debounce para no inundar el archivo con la misma oportunidad cada ciclo
    const gapKey = `${opp.route}_${opp.seller.nickName}_${opp.buyPrice}_${opp.buyer.nickName}_${opp.sellPrice}_${opp.amountUsdt}`;
    if (lastLoggedGapKey === gapKey && (Date.now() - lastLoggedTime) < 60000) {
        return;
    }
    lastLoggedGapKey = gapKey;
    lastLoggedTime = Date.now();

    const row = [
        `"${dateStr}"`,
        `"${opp.route}"`,
        `"${opp.buyPlatform}"`,
        `"${opp.seller.nickName}"`,
        opp.buyPrice,
        `"${opp.sellPlatform}"`,
        `"${opp.buyer.nickName}"`,
        opp.sellPrice,
        opp.grossSpread,
        opp.amountUsdt,
        opp.withdrawalFeeUsdt,
        opp.feeCostBob,
        opp.netProfitBob,
        opp.netProfitUsdt,
        `"${opp.netMarginPercent}%"`,
        `"${opp.seller.minBob.toFixed(0)} - ${opp.seller.maxBob.toFixed(0)} BOB"`,
        `"${opp.buyer.minBob.toFixed(0)} - ${opp.buyer.maxBob.toFixed(0)} BOB"`,
        `"${opp.limits.hasOverlap ? 'COMPATIBLE' : 'INCOMPATIBLE'}"`,
        `"${opp.limits.note.replace(/"/g, "'")}"`
    ].join(';');

    try {
        fs.appendFileSync(HISTORY_CSV, row + '\n', 'utf8');

        let jsonHistory = [];
        if (fs.existsSync(HISTORY_JSON)) {
            jsonHistory = JSON.parse(fs.readFileSync(HISTORY_JSON, 'utf8') || '[]');
        }
        jsonHistory.push({
            timestamp: now.toISOString(),
            date: dateStr,
            route: opp.route,
            buyPlatform: opp.buyPlatform,
            seller: opp.seller.nickName,
            buyPrice: opp.buyPrice,
            sellPlatform: opp.sellPlatform,
            buyer: opp.buyer.nickName,
            sellPrice: opp.sellPrice,
            grossSpread: opp.grossSpread,
            amountUsdt: opp.amountUsdt,
            withdrawalFeeUsdt: opp.withdrawalFeeUsdt,
            feeCostBob: opp.feeCostBob,
            netProfitBob: opp.netProfitBob,
            netProfitUsdt: opp.netProfitUsdt,
            netMarginPercent: opp.netMarginPercent,
            limits: opp.limits
        });

        if (jsonHistory.length > 1000) {
            jsonHistory = jsonHistory.slice(-1000);
        }
        fs.writeFileSync(HISTORY_JSON, JSON.stringify(jsonHistory, null, 2), 'utf8');
    } catch (e) {
        // Silencioso ante errores menores de guardado
    }
}

/**
 * Dibuja la consola en vivo con formato estilizado
 */
function renderDashboard({
    binanceData,
    bybitData,
    opportunities,
    executionTimeMs
}) {
    if (process.stdout.isTTY) {
        console.clear();
    } else {
        console.log('\n------------------------------------------------------------');
    }

    const now = new Date().toLocaleTimeString('es-BO', { timeZone: 'America/La_Paz' });
    const statusText = isPaused ? '⏸️  PAUSADO' : '🟢 ESCANEANDO EN VIVO';

    console.log(`========================================================================================`);
    console.log(`🤖 RADAR DE ARBITRAJE CRUZADO: BINANCE ⇆ BYBIT P2P (BOB/USDT)   [${statusText}]`);
    console.log(`⏱️ Hora: ${now} | Ciclo #${scanCount} (${executionTimeMs}ms) | Oportunidades: ${opportunitiesFound} | 🔊 Sonido: ${isSoundMuted() ? '\x1b[31m\x1b[1mOFF (MUTE)\x1b[0m' : '\x1b[32m\x1b[1mON\x1b[0m'}`);
    console.log(`⚙️ Simulación: ${SIMULATED_AMOUNT_USDT} USDT | Tarifa Binance: $${BINANCE_WITHDRAWAL_FEE} USDT | Tarifa Bybit: $${BYBIT_WITHDRAWAL_FEE} USDT`);
    console.log(`⌨️ [s]: Mute/Sonido | [+/-]: Monto | [f]: Tarifa ($0.19/$0.24/$0.29) | [p]: Pausa | [q]: Salir`);
    console.log(`========================================================================================`);

    // 1. Tabla de Cotizaciones en Vivo
    console.log(`\n📊 COTIZACIONES EN VIVO (Mejores Precios Taker):`);
    console.log(`┌──────────────┬───────────────────────────────┬───────────────────────────────┐`);
    console.log(`│ PLATAFORMA   │ MEJOR COMPRA (Donde tú compras)│ MEJOR VENTA (Donde tú vendes) │`);
    console.log(`├──────────────┼───────────────────────────────┼───────────────────────────────┤`);

    const bestBinBuy = (binanceData.sellers || [])[0];
    const bestBinSell = (binanceData.buyers || [])[0];
    const bestBybBuy = (bybitData.sellers || [])[0];
    const bestBybSell = (bybitData.buyers || [])[0];

    const formatPriceCol = (ad) => {
        if (!ad) return 'Sin anuncios       ';
        return `${ad.price.toFixed(3)} BOB (${ad.nickName.slice(0, 10).padEnd(10)})`;
    };

    console.log(`│ BINANCE      │ ${formatPriceCol(bestBinBuy).padEnd(29)} │ ${formatPriceCol(bestBinSell).padEnd(29)} │`);
    console.log(`│ BYBIT        │ ${formatPriceCol(bestBybBuy).padEnd(29)} │ ${formatPriceCol(bestBybSell).padEnd(29)} │`);
    console.log(`└──────────────┴───────────────────────────────┴───────────────────────────────┘`);

    // 2. Brechas Directas Brutas
    const spreadBinToByb = (bestBybSell && bestBinBuy) ? (bestBybSell.price - bestBinBuy.price) : 0;
    const spreadBybToBin = (bestBinSell && bestBybBuy) ? (bestBinSell.price - bestBybBuy.price) : 0;

    console.log(`\n📌 SPREADS BRUTOS BASE (Sin deducir comisión de retiro aún):`);
    console.log(`  • Ruta [Binance ➔ Bybit]: ${spreadBinToByb >= 0 ? '+' : ''}${spreadBinToByb.toFixed(3)} BOB/USDT  (Compra en Binance @ ${(bestBinBuy?.price || 0).toFixed(3)} -> Venta en Bybit @ ${(bestBybSell?.price || 0).toFixed(3)})`);
    console.log(`  • Ruta [Bybit ➔ Binance]: ${spreadBybToBin >= 0 ? '+' : ''}${spreadBybToBin.toFixed(3)} BOB/USDT  (Compra en Bybit @ ${(bestBybBuy?.price || 0).toFixed(3)} -> Venta en Binance @ ${(bestBinSell?.price || 0).toFixed(3)})`);

    // 3. Top Oportunidades Netas (Con Deducción de Comisión)
    const profitableOpps = opportunities.filter(o => o.netProfitBob > 0);
    const displayOpps = ONLY_COMPATIBLE ? profitableOpps.filter(o => o.limits.hasOverlap) : opportunities.slice(0, 5);

    console.log(`\n💎 EVALUACIÓN DE GANANCIA NETA REAL (Descontando Retiro de $${BINANCE_WITHDRAWAL_FEE} USDT en ${SIMULATED_AMOUNT_USDT} USDT):`);

    if (displayOpps.length === 0) {
        console.log(`  ⚠️ No hay ofertas activas con los filtros actuales.`);
        return;
    }

    displayOpps.forEach((opp, i) => {
        const isNetPositive = opp.netProfitBob > 0;
        const icon = isNetPositive ? '🔥 [GANANCIA NETA]' : '⏳ [AÚN NO RENTABLE]';
        const profitSign = opp.netProfitBob >= 0 ? '+' : '';
        const breakEvenStr = `Spread mín necesario: ${opp.breakEvenSpreadBob.toFixed(3)} BOB`;

        let limitBadge = '❌ [INCOMPATIBLE]';
        if (opp.limits.isAmountEligible) {
            limitBadge = '✅ [COMPATIBLE]';
        } else if (opp.limits.hasOverlap) {
            limitBadge = '⚠️ [MONTO FUERA DE RANGO]';
        }

        console.log(`\n  ${i + 1}. ${icon} Ruta: ${opp.route}`);
        console.log(`     • Compra : ${opp.buyPlatform} @ ${opp.buyPrice.toFixed(3)} BOB | Vendedor: ${opp.seller.nickName} | Lím: ${opp.seller.minBob.toFixed(0)}-${opp.seller.maxBob.toFixed(0)} BOB`);
        console.log(`     • Venta  : ${opp.sellPlatform} @ ${opp.sellPrice.toFixed(3)} BOB | Comprador: ${opp.buyer.nickName} | Lím: ${opp.buyer.minBob.toFixed(0)}-${opp.buyer.maxBob.toFixed(0)} BOB`);
        console.log(`     • Spread : Bruto ${opp.grossSpread >= 0 ? '+' : ''}${opp.grossSpread.toFixed(3)} BOB | Comisión Retiro: $${opp.withdrawalFeeUsdt} USDT (${opp.feeCostBob} BOB)`);
        console.log(`     • RETORNO: ${profitSign}${opp.netProfitBob} BOB (${profitSign}${opp.netProfitUsdt} USDT) | Margen Neto: ${opp.netMarginPercent}% | ${breakEvenStr}`);
        console.log(`     • Límites: ${limitBadge} ${opp.limits.note}`);
    });

    // 4. Tabla de Sensibilidad según Volumen (Escala de Montos)
    if (bestBinBuy && bestBybSell) {
        console.log(`\n📈 SENSIBILIDAD POR MONTO EN RUTA [BINANCE ➔ BYBIT] (Tarifa Retiro: $${BINANCE_WITHDRAWAL_FEE} USDT):`);
        const sampleAmounts = [100, 250, 500, 1000];
        const sensitivityRows = sampleAmounts.map(amt => {
            const res = evaluateArbitrageOpportunity({
                route: 'BINANCE ➔ BYBIT',
                buyAd: bestBinBuy,
                sellAd: bestBybSell,
                amountUsdt: amt,
                withdrawalFeeUsdt: BINANCE_WITHDRAWAL_FEE
            });
            const sign = res.netProfitBob >= 0 ? '+' : '';
            return `     $${String(amt).padEnd(4)} USDT ➔ Inversión: ${res.fiatSpentBob.toFixed(0)} BOB | Neto: ${sign}${res.netProfitBob} BOB (${sign}${res.netProfitUsdt} USDT) | ROI: ${res.netMarginPercent}%`;
        });
        sensitivityRows.forEach(r => console.log(r));
    }

    console.log(`\n----------------------------------------------------------------------------------------`);
}

/**
 * Ciclo principal de escaneo
 */
async function runScanCycle() {
    if (isPaused) return;

    scanCount++;
    const startTime = Date.now();

    try {
        // Consulta concurrente en paralelo a Binance P2P y Bybit P2P
        const [binBuyAds, binSellAds, bybBuyAds, bybSellAds] = await Promise.all([
            fetchBinanceP2P({ tradeType: 'BUY', rows: 8 }).catch(e => {
                console.error('Error al consultar Binance BUY:', e.message);
                return [];
            }),
            fetchBinanceP2P({ tradeType: 'SELL', rows: 8 }).catch(e => {
                console.error('Error al consultar Binance SELL:', e.message);
                return [];
            }),
            fetchBybitP2P({ side: '1', size: 8 }).catch(e => {
                console.error('Error al consultar Bybit BUY:', e.message);
                return [];
            }),
            fetchBybitP2P({ side: '0', size: 8 }).catch(e => {
                console.error('Error al consultar Bybit SELL:', e.message);
                return [];
            })
        ]);

        const cleanBinBuyAds = filterIgnoredBinance(binBuyAds);
        const cleanBinSellAds = filterIgnoredBinance(binSellAds);

        const binanceData = normalizeBinanceAds(cleanBinBuyAds, cleanBinSellAds);
        const bybitData = normalizeBybitAds(bybBuyAds, bybSellAds);

        // Encontrar oportunidades netas
        const opportunities = findCrossArbitrageOpportunities(
            binanceData,
            bybitData,
            SIMULATED_AMOUNT_USDT,
            BINANCE_WITHDRAWAL_FEE,
            BYBIT_WITHDRAWAL_FEE
        );

        const executionTimeMs = Date.now() - startTime;

        // Renderizar tablero
        renderDashboard({
            binanceData,
            bybitData,
            opportunities,
            executionTimeMs
        });

        // Verificar oportunidades con ganancia neta
        const topProfitable = opportunities.find(o => o.netProfitBob >= MIN_NET_PROFIT_BOB && (!ONLY_COMPATIBLE || o.limits.hasOverlap));

        if (topProfitable) {
            opportunitiesFound++;
            logOpportunityToHistory(topProfitable);

            // Alerta sonora (respetando cooldown de 2.5s)
            const now = Date.now();
            if (now - lastSoundAlertTime > 3000) {
                lastSoundAlertTime = now;
                const platform = (topProfitable.route || '').toLowerCase().includes('binance') ? 'binance' : 'bybit';
                playAlertSound({ type: 'alarm', platform });
            }
        }
    } catch (err) {
        console.error('Error general en ciclo de escaneo:', err.message);
    }
}

/**
 * Inicialización de controles interactivos por teclado
 */
function setupKeyboardControls() {
    if (!process.stdin.isTTY) return;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    process.stdin.on('keypress', (str, key) => {
        if (!key) return;

        // Tecla [s]: Silenciar / Activar sonido (Switch Mute)
        if (key.name === 's' || str === 's' || str === 'S') {
            const muted = toggleSoundMute();
            console.log(muted ? '\n🔇 [SONIDO ARBITRAJE]: SILENCIADO (Mute ON)' : '\n🔊 [SONIDO ARBITRAJE]: ACTIVADO (Mute OFF)');
            return;
        }

        // Salir con Ctrl+C o 'q'
        if ((key.ctrl && key.name === 'c') || key.name === 'q') {
            console.log('\n👋 Cerrando Radar de Arbitraje. ¡Hasta luego!');
            process.exit(0);
        }

        // Aumentar monto (+)
        if (str === '+' || str === '=') {
            SIMULATED_AMOUNT_USDT += 50;
            console.log(`\n➕ Monto simulado aumentado a: ${SIMULATED_AMOUNT_USDT} USDT`);
            runScanCycle();
            return;
        }

        // Disminuir monto (-)
        if (str === '-' || str === '_') {
            SIMULATED_AMOUNT_USDT = Math.max(10, SIMULATED_AMOUNT_USDT - 50);
            console.log(`\n➖ Monto simulado reducido a: ${SIMULATED_AMOUNT_USDT} USDT`);
            runScanCycle();
            return;
        }

        // Alternar tarifa de retiro Binance: 0.19 -> 0.24 -> 0.29 -> 0.19
        if (key.name === 'f') {
            if (BINANCE_WITHDRAWAL_FEE === 0.19) {
                BINANCE_WITHDRAWAL_FEE = 0.24;
            } else if (BINANCE_WITHDRAWAL_FEE === 0.24) {
                BINANCE_WITHDRAWAL_FEE = 0.29;
            } else {
                BINANCE_WITHDRAWAL_FEE = 0.19;
            }
            console.log(`\n🔄 Tarifa de retiro Binance cambiada a: $${BINANCE_WITHDRAWAL_FEE} USDT`);
            runScanCycle();
            return;
        }

        // Pausar / Reanudar con 'p' o barra espaciadora
        if (key.name === 'p' || key.name === 'space') {
            isPaused = !isPaused;
            console.log(`\n${isPaused ? '⏸️ MONITOREO PAUSADO' : '▶️ MONITOREO REANUDADO'}`);
            if (!isPaused) runScanCycle();
            return;
        }

        // Refresco manual con 'r'
        if (key.name === 'r') {
            console.log('\n🔄 Refresco forzado...');
            runScanCycle();
            return;
        }
    });
}

/**
 * Función de arranque
 */
async function main() {
    initHistoryCSV();

    if (RUN_ONCE) {
        console.log(`🚀 Ejecutando escaneo único de arbitraje Binance ⇆ Bybit...`);
        await runScanCycle();
        process.exit(0);
    }

    console.log(`🚀 Iniciando Radar de Arbitraje Binance ⇆ Bybit P2P...`);
    setupKeyboardControls();

    // Primer escaneo inmediato
    await runScanCycle();

    // Bucle continuo según el intervalo
    setInterval(() => {
        runScanCycle();
    }, REFRESH_INTERVAL_MS);
}

// Ejecutar
if (require.main === module) {
    main();
}

module.exports = {
    evaluateArbitrageOpportunity,
    findCrossArbitrageOpportunities,
    checkLimitCompatibility,
    normalizeBinanceAds,
    normalizeBybitAds
};
