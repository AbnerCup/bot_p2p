/**
 * RADAR CAZADOR DE BRECHAS PURAS BINANCE P2P (ARBITRAJE TAKER ➔ TAKER)
 * Con Ejecución Semi-Automática de Pedidos con 1 Sola Tecla.
 * 
 * FÓRMULA DINÁMICA DE RENTABILIDAD EXACTA:
 *   1. a = tradeUsdt (o Capital_Bs / buyPrice)
 *   2. b = a - 0.15$ (deducción fija de $0.15 USDT comisiones Binance: compra + venta)
 *   3. Ganancia Neta Real = (b * sellPrice) - (a * buyPrice)
 * 
 * El radar calcula el tamaño ejecutable para cada oportunidad dinámicamente según
 * tu capital máximo disponible (360 $ USDT por defecto) y los límites del anuncio,
 * disparando la alarma sonora (Alarm02.wav) ÚNICAMENTE cuando la Ganancia Neta > 0 Bs.
 * 
 * Controles Rápidos al Detectar Oportunidad:
 * - [c] o [Enter]: Comprar automáticamente el monto en USDT al vendedor barato en Binance.
 * - [v]: Vender automáticamente el monto en USDT al comprador caro en Binance.
 * - [Espacio] o [p]: Pausar / Ignorar.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchBinanceP2P } = require('./binance/market');
const { playAlertSound, toggleSoundMute, isSoundMuted } = require('./utils/sound');
const { loadIgnoredMerchants, addIgnoredMerchant, removeIgnoredMerchant, filterIgnoredMerchants } = require('./binance/eligibility');
const { loadEnv } = require('./config');
const { createRadarLogger } = require('./utils/radar_logger');

const env = loadEnv();

// Archivos de historial
const HISTORY_CSV = path.join(__dirname, 'binance_market_history.csv');
const HISTORY_JSON = path.join(__dirname, 'binance_market_history.json');

// Configuración de Capital Dinámico y Comisiones Binance
let REFRESH_INTERVAL_MS = 800;    // Refresco cada 800ms por defecto
let MAX_CAPITAL_USDT = 360;       // Capital máximo rotativo disponible del usuario ($360 USDT por defecto)
// Fee del taker en Binance P2P = $0 (confirmado para operación taker↔taker dentro del mismo exchange).
// Mantener en 0 para same-exchange. Overridear con --fee <X> cuando se modele arbitraje cruzado:
// p.ej. --fee 0.29 para simular retiro BEP-20 saliendo de Binance hacia Bybit.
let BINANCE_TOTAL_FEE_USDT = 0.00;
let MIN_NET_PROFIT_BOB = 0.01;    // Alarma solo cuando la ganancia neta real sea positiva (>= 0.01 BOB)
let DEFAULT_TRADE_USDT = 360;     // Monto base sugerido
const radarArgs = process.argv.slice(2);

// Parámetros CLI o .env para Capital y Comisiones:
const capUsdtIdx = radarArgs.findIndex(a => a === '--max-usdt' || a === '--capital-usdt' || a === '--usdt');
if (capUsdtIdx !== -1 && radarArgs[capUsdtIdx + 1] && !isNaN(parseFloat(radarArgs[capUsdtIdx + 1]))) {
    MAX_CAPITAL_USDT = parseFloat(radarArgs[capUsdtIdx + 1]);
} else if (env.BINANCE_MAX_CAPITAL_USDT && !isNaN(parseFloat(env.BINANCE_MAX_CAPITAL_USDT))) {
    MAX_CAPITAL_USDT = parseFloat(env.BINANCE_MAX_CAPITAL_USDT);
}

const feeArgIdx = radarArgs.findIndex(a => a === '--fee' || a === '--total-fee');
if (feeArgIdx !== -1 && radarArgs[feeArgIdx + 1] && !isNaN(parseFloat(radarArgs[feeArgIdx + 1]))) {
    BINANCE_TOTAL_FEE_USDT = parseFloat(radarArgs[feeArgIdx + 1]);
} else if (env.BINANCE_TOTAL_FEE_USDT && !isNaN(parseFloat(env.BINANCE_TOTAL_FEE_USDT))) {
    BINANCE_TOTAL_FEE_USDT = parseFloat(env.BINANCE_TOTAL_FEE_USDT);
}

const minProfitIdx = radarArgs.findIndex(a => a === '--min-profit' || a === '--profit');
if (minProfitIdx !== -1 && radarArgs[minProfitIdx + 1] && !isNaN(parseFloat(radarArgs[minProfitIdx + 1]))) {
    MIN_NET_PROFIT_BOB = parseFloat(radarArgs[minProfitIdx + 1]);
}

let ONLY_COMPATIBLE_LIMITS = radarArgs.includes('--strict') || radarArgs.includes('--only-compatible');

// Parámetros de velocidad / intervalo / latencia:
const intervalIdx = radarArgs.findIndex(a => a === '--interval' || a === '-i');
if (intervalIdx !== -1 && radarArgs[intervalIdx + 1] && !isNaN(parseInt(radarArgs[intervalIdx + 1]))) {
    REFRESH_INTERVAL_MS = parseInt(radarArgs[intervalIdx + 1], 10);
} else if (radarArgs.includes('--ultra')) {
    REFRESH_INTERVAL_MS = 250; // Ultra rápido (~4.5 req/s)
} else if (radarArgs.includes('--fast')) {
    REFRESH_INTERVAL_MS = 400; // Rápido (~2.7 req/s)
} else if (radarArgs.includes('--slow')) {
    REFRESH_INTERVAL_MS = 2000; // Lento / Ahorro (~0.8 req/s)
} else {
    const directMs = radarArgs.find(a => /^\d{3,4}$/.test(a));
    if (directMs) REFRESH_INTERVAL_MS = parseInt(directMs, 10);
}

let isPaused = false;
let isExecutingOrder = false;
let scanCount = 0;
let opportunitiesCount = 0;
let lastAlertTime = null;
let currentActiveGap = null;

// Cooldown post-ejecución para prevenir disparos accidentales:
// durante los segundos que tarda Playwright en ejecutar una orden, el usuario puede
// pulsar teclas (nervios, impaciencia) que Node encola. Cuando la orden termina,
// esos eventos se procesan y pueden disparar OTRA orden si no hay un gate temporal.
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 5000;

// Inicializar cabeceras CSV si no existe
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Inicializar cabeceras CSV si no existe o actualizar al nuevo formato extendido
function initHistoryCSV() {
    const headers = [
        'Fecha_Hora',
        'Tipo_Registro',
        'Compre_En_Oportunidad',
        'Oportunidad_Compra_BOB',
        'Vendedor',
        'Pico_Venta_BOB',
        'Comprador_Pico',
        'Spread_Ganancia_BOB',
        'Margen_Porcentaje',
        'Cantidad_USDT',
        'Total_BOB',
        'Ganancia_Estimada_BOB',
        'Limites_Compra_BOB',
        'Limites_Venta_BOB',
        'Compatibilidad_Limites',
        'Detalle'
    ].join(';');

    if (fs.existsSync(HISTORY_CSV)) {
        try {
            const firstLine = fs.readFileSync(HISTORY_CSV, 'utf8').split('\n')[0] || '';
            if (!firstLine.includes('Compre_En_Oportunidad') || !firstLine.includes('Oportunidad_Compra_BOB')) {
                const backupPath = path.join(__dirname, 'binance_market_history_backup.csv');
                fs.copyFileSync(HISTORY_CSV, backupPath);
                fs.writeFileSync(HISTORY_CSV, headers + '\n', 'utf8');
            }
        } catch (e) {}
    } else {
        fs.writeFileSync(HISTORY_CSV, headers + '\n', 'utf8');
    }
}

let lastLoggedGapKey = null;
let lastLoggedTime = 0;

// Registrar operación en history.json para que ejercicio.js y reportes lo sincronicen
function recordTradeInHistory({ type, cryptoAmount, price, fiatAmount, counterparty }) {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {}
    }
    const now = new Date();
    history.push({
        id: `BINANCE-RADAR-${Date.now()}`,
        date: now.toISOString().slice(0, 10),
        timestamp: now.toISOString(),
        type: type, // 'COMPRA' o 'VENTA'
        cryptoAmount: parseFloat(cryptoAmount),
        fiatAmount: parseFloat(fiatAmount),
        price: parseFloat(price),
        profitBob: 0,
        bank: 'BANCO SOL',
        counterparty: counterparty,
        status: 'EXITOSO',
        reason: 'Ejecutado desde Radar de Brechas Binance'
    });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

// Guardar en el historial CSV y JSON comparando Oportunidad de Compra vs Pico de Venta
// Nuevo logger centralizado (JSONL append-only + debounce por estado + flush legacy en background)
const radarLogger = createRadarLogger({
    exchange: 'binance',
    csvPath: HISTORY_CSV,
    jsonPath: HISTORY_JSON,
    jsonlDir: __dirname,
    defaultTradeUsdt: DEFAULT_TRADE_USDT
});

// Adapter de compatibilidad con el código que seguía llamando logOpportunity().
// - Si es ejecución (compra/venta/marcado manual) → siempre escribe (evento EXEC).
// - Si es solo detección de brecha → delega a trackGap() que decide OPEN/UPDATE/silencio.
function logOpportunity(opp, execution = { executed: false }) {
    if (execution.executed) {
        radarLogger.logExecution(opp, execution);
    } else {
        radarLogger.trackGap(opp);
    }
}

// Cerrar limpio al salir (flush del .json legacy pendiente)
process.on('exit', () => { try { radarLogger.flushNow(); } catch (e) {} });
process.on('SIGINT', () => { try { radarLogger.flushNow(); } catch (e) {} process.exit(0); });

/**
 * Calcula y normaliza los límites en BOB y USDT, y evalúa el solapamiento en Binance
 */
function analyzeBinanceLimitCompatibility(buyPrice, sellerAdv, sellPrice, buyerAdv) {
    // 1. Límites de Compra (Vendedor de USDT donde nosotros compramos)
    const buyMinBob = parseFloat(sellerAdv.minSingleTransAmount) || 0;
    const buyMaxBobRaw = parseFloat(sellerAdv.maxSingleTransAmount) || 0;
    const sellerAvailUsdt = parseFloat(sellerAdv.surplusAmount) || 0;

    const buyMinUsdt = buyPrice > 0 ? buyMinBob / buyPrice : 0;
    let buyMaxUsdt = buyPrice > 0 ? buyMaxBobRaw / buyPrice : 0;
    if (sellerAvailUsdt > 0 && sellerAvailUsdt < buyMaxUsdt) {
        buyMaxUsdt = sellerAvailUsdt;
    }
    const buyMaxBob = buyMaxUsdt * buyPrice;

    // 2. Límites de Venta (Comprador de USDT donde nosotros vendemos)
    const sellMinBob = parseFloat(buyerAdv.minSingleTransAmount) || 0;
    const sellMaxBobRaw = parseFloat(buyerAdv.maxSingleTransAmount) || 0;
    const buyerAvailUsdt = parseFloat(buyerAdv.surplusAmount) || 0;

    const sellMinUsdt = sellPrice > 0 ? sellMinBob / sellPrice : 0;
    let sellMaxUsdt = sellPrice > 0 ? sellMaxBobRaw / sellPrice : 0;
    if (buyerAvailUsdt > 0 && buyerAvailUsdt < sellMaxUsdt) {
        sellMaxUsdt = buyerAvailUsdt;
    }
    const sellMaxBob = sellMaxUsdt * sellPrice;

    // 3. Solapamiento (Rango ejecutable)
    const overlapMinUsdt = Math.max(buyMinUsdt, sellMinUsdt);
    const overlapMaxUsdt = Math.min(buyMaxUsdt, sellMaxUsdt);
    const hasOverlap = overlapMaxUsdt >= overlapMinUsdt && overlapMaxUsdt > 0;

    let reason = '';
    let suggestedTradeUsdt = MAX_CAPITAL_USDT;

    if (hasOverlap) {
        if (MAX_CAPITAL_USDT < overlapMinUsdt) {
            suggestedTradeUsdt = parseFloat(overlapMinUsdt.toFixed(2));
        } else if (MAX_CAPITAL_USDT > overlapMaxUsdt) {
            suggestedTradeUsdt = parseFloat(overlapMaxUsdt.toFixed(2));
        } else {
            suggestedTradeUsdt = MAX_CAPITAL_USDT;
        }
    } else {
        if (buyMaxUsdt < sellMinUsdt) {
            const missingUsdt = (sellMinUsdt - buyMaxUsdt).toFixed(2);
            const missingBob = (sellMinBob - buyMaxBob).toFixed(2);
            reason = `El vendedor solo vende hasta ${buyMaxUsdt.toFixed(2)} USDT (${buyMaxBob.toFixed(2)} BOB), pero el comprador pide un MÍNIMO de ${sellMinUsdt.toFixed(2)} USDT (${sellMinBob.toFixed(2)} BOB). Faltan ${missingUsdt} USDT (${missingBob} BOB) para alcanzar su mínimo.`;
        } else if (sellMaxUsdt < buyMinUsdt) {
            reason = `El comprador solo acepta hasta ${sellMaxUsdt.toFixed(2)} USDT (${sellMaxBob.toFixed(2)} BOB), pero el vendedor exige una compra MÍNIMA de ${buyMinUsdt.toFixed(2)} USDT (${buyMinBob.toFixed(2)} BOB).`;
        } else {
            reason = `Límites no compatibles entre los anuncios seleccionados.`;
        }
    }

    return {
        buy: {
            minBob: buyMinBob,
            maxBob: buyMaxBob,
            minUsdt: buyMinUsdt,
            maxUsdt: buyMaxUsdt,
            availUsdt: sellerAvailUsdt
        },
        sell: {
            minBob: sellMinBob,
            maxBob: sellMaxBob,
            minUsdt: sellMinUsdt,
            maxUsdt: sellMaxUsdt,
            availUsdt: buyerAvailUsdt
        },
        hasOverlap,
        overlapMinUsdt,
        overlapMaxUsdt,
        overlapMinBob: overlapMinUsdt * buyPrice,
        overlapMaxBob: overlapMaxUsdt * buyPrice,
        suggestedTradeUsdt,
        reason
    };
}

/**
 * FÓRMULA DINÁMICA DE RENTABILIDAD EXACTA:
 *   1. a = tradeUsdt (o Capital_Bs / buyPrice)
 *   2. b = a - feeUsdt (deducción fija de $0.15 USDT compra + venta)
 *   3. fiatReceived = b * sellPrice
 *   4. fiatSpent = a * buyPrice
 *   5. netProfitBob = fiatReceived - fiatSpent = (a * spread) - (feeUsdt * sellPrice)
 */
function calculateDynamicBinanceProfit({ buyPrice, sellPrice, tradeUsdt = null, capitalBob = null }) {
    if (!buyPrice || buyPrice <= 0 || !sellPrice || sellPrice <= 0) {
        return { isProfitable: false, netProfitBob: 0, breakEvenSpreadBob: 0 };
    }

    const spread = parseFloat((sellPrice - buyPrice).toFixed(3));

    let a = 0;
    if (tradeUsdt && tradeUsdt > 0) {
        a = tradeUsdt;
    } else if (capitalBob && capitalBob > 0) {
        a = capitalBob / buyPrice;
    } else {
        a = MAX_CAPITAL_USDT;
    }
    a = parseFloat(a.toFixed(2));

    const feeUsdt = BINANCE_TOTAL_FEE_USDT;
    const b = parseFloat((a - feeUsdt).toFixed(2));

    if (b <= 0) {
        return {
            a,
            b: 0,
            feeUsdt,
            feeCostBob: parseFloat((feeUsdt * sellPrice).toFixed(2)),
            fiatSpentBob: parseFloat((a * buyPrice).toFixed(2)),
            fiatReceivedBob: 0,
            grossProfitBob: 0,
            netProfitBob: parseFloat((-a * buyPrice).toFixed(2)),
            breakEvenSpreadBob: 999,
            spread,
            isProfitable: false
        };
    }

    const fiatReceivedBob = b * sellPrice;
    const fiatSpentBob = a * buyPrice;
    const netProfitBob = parseFloat((fiatReceivedBob - fiatSpentBob).toFixed(2));
    const grossProfitBob = parseFloat((a * spread).toFixed(2));
    const feeCostBob = parseFloat((feeUsdt * sellPrice).toFixed(2));
    const netMarginPercent = fiatSpentBob > 0 ? parseFloat(((netProfitBob / fiatSpentBob) * 100).toFixed(2)) : 0;
    const breakEvenSpreadBob = a > 0 ? parseFloat(((feeUsdt * sellPrice) / a).toFixed(3)) : 0;

    return {
        a,
        b,
        feeUsdt,
        spread,
        feeCostBob,
        grossProfitBob,
        fiatSpentBob: parseFloat(fiatSpentBob.toFixed(2)),
        fiatReceivedBob: parseFloat(fiatReceivedBob.toFixed(2)),
        netProfitBob,
        netMarginPercent,
        breakEvenSpreadBob,
        isProfitable: netProfitBob >= MIN_NET_PROFIT_BOB
    };
}

/**
 * Encuentra brechas donde Precio_Venta > Precio_Compra en Binance
 * y verifica que sean RENTABLES deduciendo las comisiones fijas ($0.15 USDT)
 * adaptándose dinámicamente al tamaño ejecutable del anuncio y tu capital.
 */
function findBinanceArbitrageGaps(sellers = [], buyers = []) {
    // sellers: anuncios tradeType 'BUY' en API de Binance (donde nosotros compramos USDT como Taker)
    // buyers: anuncios tradeType 'SELL' en API de Binance (donde nosotros vendemos USDT como Taker)
    const gaps = [];

    for (const s of sellers.slice(0, 8)) {
        const advS = s.adv || {};
        const buyPrice = parseFloat(advS.price || 0);
        const merchantS = s.advertiser || {};

        for (const b of buyers.slice(0, 8)) {
            const advB = b.adv || {};
            const sellPrice = parseFloat(advB.price || 0);
            const merchantB = b.advertiser || {};

            if (sellPrice > buyPrice && buyPrice > 0) {
                const spread = parseFloat((sellPrice - buyPrice).toFixed(3));
                const limits = analyzeBinanceLimitCompatibility(buyPrice, advS, sellPrice, advB);

                // Si ONLY_COMPATIBLE_LIMITS está activo, omitir no compatibles
                if (ONLY_COMPATIBLE_LIMITS && !limits.hasOverlap) {
                    continue;
                }

                // CÁLCULO DINÁMICO SEGÚN TU CAPITAL (Máximo 360 $ o lo que permitan los límites):
                let dynamicTradeUsdt = MAX_CAPITAL_USDT;
                if (limits.hasOverlap) {
                    const maxPossible = Math.min(MAX_CAPITAL_USDT, limits.overlapMaxUsdt);
                    if (maxPossible >= limits.overlapMinUsdt) {
                        dynamicTradeUsdt = maxPossible;
                    } else {
                        dynamicTradeUsdt = limits.overlapMinUsdt;
                    }
                }
                dynamicTradeUsdt = parseFloat(dynamicTradeUsdt.toFixed(2));

                // Evaluar con la fórmula dinámica para el monto de esta oportunidad:
                const dynamicProfit = calculateDynamicBinanceProfit({
                    buyPrice,
                    sellPrice,
                    tradeUsdt: dynamicTradeUsdt
                });

                // Comparativas informativas:
                const profit100 = calculateDynamicBinanceProfit({
                    buyPrice,
                    sellPrice,
                    capitalBob: 100
                });

                const profit1000 = calculateDynamicBinanceProfit({
                    buyPrice,
                    sellPrice,
                    capitalBob: 1000
                });

                const profitMaxCapital = calculateDynamicBinanceProfit({
                    buyPrice,
                    sellPrice,
                    tradeUsdt: MAX_CAPITAL_USDT
                });

                // La alarma se dispara ÚNICAMENTE si la Ganancia Neta Real es positiva (> 0 BOB)
                // con el monto que efectivamente se puede ejecutar según los límites y tu capital:
                const isProfitable = limits.hasOverlap ? dynamicProfit.isProfitable : profitMaxCapital.isProfitable;

                if (isProfitable) {
                    gaps.push({
                        seller: {
                            nickName: merchantS.nickName || 'Vendedor',
                            minAmount: advS.minSingleTransAmount || '0',
                            maxAmount: advS.maxSingleTransAmount || '0',
                            lastQuantity: advS.surplusAmount || '0',
                            recentExecuteRate: (merchantS.monthFinishRate * 100).toFixed(0),
                            payments: (advS.tradeMethods || []).map(m => m.tradeMethodName)
                        },
                        buyer: {
                            nickName: merchantB.nickName || 'Comprador',
                            minAmount: advB.minSingleTransAmount || '0',
                            maxAmount: advB.maxSingleTransAmount || '0',
                            lastQuantity: advB.surplusAmount || '0',
                            recentExecuteRate: (merchantB.monthFinishRate * 100).toFixed(0),
                            payments: (advB.tradeMethods || []).map(m => m.tradeMethodName)
                        },
                        buyPrice,
                        sellPrice,
                        spread,
                        marginPercent: dynamicProfit.netMarginPercent,
                        limits,
                        dynamicTradeUsdt,
                        dynamicProfit,
                        profit100,
                        profit1000,
                        profitMaxCapital,
                        netProfitBob: dynamicProfit.netProfitBob,
                        detail: `Comprar a ${buyPrice.toFixed(2)} BOB y vender a ${sellPrice.toFixed(2)} BOB en Binance`
                    });
                }
            }
        }
    }

    // Ordenar: primero los que tienen límites compatibles (solapamiento), y luego por mayor Ganancia Neta Real
    gaps.sort((a, b) => {
        if (a.limits.hasOverlap && !b.limits.hasOverlap) return -1;
        if (!a.limits.hasOverlap && b.limits.hasOverlap) return 1;
        return b.netProfitBob - a.netProfitBob;
    });

    return gaps;
}

/**
 * Renderizado de Alerta Visual Gigante para Binance
 */
function renderBigGapAlert(opp, nowTime) {
    process.stdout.write('\x07\x07\x07\x07');

    const l = opp.limits;
    const isCompat = l.hasOverlap;

    // Reproducir alerta sonora potente Binance (Alarm02.wav)
    if (isCompat) {
        playAlertSound({ type: 'alarm', platform: 'binance' }); // Alarma fuerte de Windows para Binance (Alarm02.wav)
    } else {
        playAlertSound({ type: 'siren', platform: 'binance' }); // Sirena de atención Binance
    }

    console.log('\n');
    if (isCompat) {
        console.log('\x1b[42m\x1b[30m\x1b[1m' + '╔══════════════════════════════════════════════════════════════════════════════════════╗' + '\x1b[0m');
        console.log('\x1b[42m\x1b[30m\x1b[1m' + '║  🚨🚨🚨 ¡BRECHA DETECTADA Y LÍMITES 100% COMPATIBLES EN BINANCE! 🚨🚨🚨              ║'.padEnd(89, ' ') + '\x1b[0m');
        console.log('\x1b[42m\x1b[30m\x1b[1m' + '╚══════════════════════════════════════════════════════════════════════════════════════╝' + '\x1b[0m');
    } else {
        console.log('\x1b[41m\x1b[37m\x1b[1m' + '╔══════════════════════════════════════════════════════════════════════════════════════╗' + '\x1b[0m');
        console.log('\x1b[41m\x1b[37m\x1b[1m' + '║  ⚠️⚠️⚠️ ¡BRECHA EN BINANCE PERO LÍMITES INCOMPATIBLES (SIN SOLAPAMIENTO)! ⚠️⚠️⚠️      ║'.padEnd(89, ' ') + '\x1b[0m');
        console.log('\x1b[41m\x1b[37m\x1b[1m' + '╚══════════════════════════════════════════════════════════════════════════════════════╝' + '\x1b[0m');
    }

    const pDyn = opp.dynamicProfit || calculateDynamicBinanceProfit({ buyPrice: opp.buyPrice, sellPrice: opp.sellPrice, tradeUsdt: opp.dynamicTradeUsdt || l.suggestedTradeUsdt });
    const pMax = opp.profitMaxCapital || calculateDynamicBinanceProfit({ buyPrice: opp.buyPrice, sellPrice: opp.sellPrice, tradeUsdt: MAX_CAPITAL_USDT });
    const p1000 = opp.profit1000 || calculateDynamicBinanceProfit({ buyPrice: opp.buyPrice, sellPrice: opp.sellPrice, capitalBob: 1000 });

    const formatProfit = (val) => {
        const formatted = Math.abs(val).toFixed(2);
        if (val > 0) return `\x1b[32m\x1b[1m+${formatted} Bs\x1b[0m`;
        if (val < 0) return `\x1b[31m\x1b[1m-${formatted} Bs\x1b[0m`;
        return `0.00 Bs`;
    };

    console.log('\x1b[32m\x1b[1m' + `\n 💰 GANANCIA NETA REAL:       +${pDyn.netProfitBob.toFixed(2)} BOB NETOS  (para orden ejecutable de ${pDyn.a} $ USDT)` + '\x1b[0m');
    console.log(` 📐 FÓRMULA DINÁMICA:         a = ${pDyn.a} $ ➔ b = (a - ${pDyn.feeUsdt}$) = ${pDyn.b} $ ➔ b × ${opp.sellPrice.toFixed(2)} BOB = ${pDyn.fiatReceivedBob.toFixed(2)} Bs (Gasto: ${pDyn.fiatSpentBob.toFixed(2)} Bs)`);
    console.log(` 💸 Deducción comisiones:     -${pDyn.feeCostBob.toFixed(2)} BOB ($${pDyn.feeUsdt} USDT fijos por compra + venta)`);
    console.log(` 📈 Spread Bruto:             +${opp.spread.toFixed(3)} BOB por USDT (Break-even para este monto: >= ${pDyn.breakEvenSpreadBob.toFixed(3)} BOB)`);
    console.log('----------------------------------------------------------------------------------------');
    
    // Paso 1: Compra
    console.log('\x1b[1m' + ' 🟢 PASO 1 (COMPRAR USDT BARATO EN BINANCE):' + '\x1b[0m');
    console.log(`    - Comerciante:   \x1b[32m\x1b[1m${opp.seller.nickName}\x1b[0m (Tasa éxito: ${opp.seller.recentExecuteRate}%)`);
    console.log(`    - Precio Compra: \x1b[32m\x1b[1m${opp.buyPrice.toFixed(2)} BOB\x1b[0m`);
    console.log(`    - Límites BOB:   ${l.buy.minBob.toFixed(2)} BOB a ${l.buy.maxBob.toFixed(2)} BOB`);
    console.log(`    - Límites USDT:  \x1b[36m\x1b[1m${l.buy.minUsdt.toFixed(2)} $ a ${l.buy.maxUsdt.toFixed(2)} $ USDT\x1b[0m (Disp: ${l.buy.availUsdt} USDT)`);
    console.log(`    - Pagos:         [${opp.seller.payments.join(', ') || 'N/A'}]`);

    // Paso 2: Venta
    console.log('\x1b[1m' + '\n 🔴 PASO 2 (VENDER USDT CARO EN BINANCE):' + '\x1b[0m');
    console.log(`    - Comerciante:   \x1b[31m\x1b[1m${opp.buyer.nickName}\x1b[0m (Tasa éxito: ${opp.buyer.recentExecuteRate}%)`);
    console.log(`    - Precio Venta:  \x1b[31m\x1b[1m${opp.sellPrice.toFixed(2)} BOB\x1b[0m  \x1b[33m(¡+${opp.spread.toFixed(3)} Bs más caro!)\x1b[0m`);
    console.log(`    - Límites BOB:   ${l.sell.minBob.toFixed(2)} BOB a ${l.sell.maxBob.toFixed(2)} BOB`);
    console.log(`    - Límites USDT:  \x1b[36m\x1b[1m${l.sell.minUsdt.toFixed(2)} $ a ${l.sell.maxUsdt.toFixed(2)} $ USDT\x1b[0m (Disp: ${l.sell.availUsdt} USDT)`);
    console.log(`    - Pagos:         [${opp.buyer.payments.join(', ') || 'N/A'}]`);

    // Bloque de Verificación de Límites y Compatibilidad
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[1m' + ' 🔍 VERIFICACIÓN DE LÍMITES Y COMPATIBILIDAD:' + '\x1b[0m');
    if (isCompat) {
        console.log(` \x1b[32m\x1b[1m  ✅ ¡LÍMITES 100% COMPATIBLES Y SOLAPADOS!\x1b[0m`);
        console.log(`    - Rango que puedes arbitrar:  \x1b[32m\x1b[1mDe ${l.overlapMinUsdt.toFixed(2)} $ a ${l.overlapMaxUsdt.toFixed(2)} $ USDT\x1b[0m`);
        console.log(`    - Equivalente en Bolivianos:  De ${l.overlapMinBob.toFixed(2)} Bs a ${l.overlapMaxBob.toFixed(2)} Bs`);
        console.log(`    - Monto dinámico para orden:  \x1b[33m\x1b[1m${opp.dynamicTradeUsdt || l.suggestedTradeUsdt} USDT\x1b[0m`);
        console.log(`    - Ganancia neta estimada:     \x1b[32m\x1b[1m+${pDyn.netProfitBob.toFixed(2)} BOB netos\x1b[0m`);
    } else {
        console.log(` \x1b[31m\x1b[1m  🚨 ¡ATENCIÓN: LÍMITES INCOMPATIBLES (SIN SOLAPAMIENTO DIRECTO)!\x1b[0m`);
        console.log(`    ⛔ ${l.reason}`);
        console.log(`    ⚠️ \x1b[33mPELIGRO:\x1b[0m Si compras a ${opp.buyPrice.toFixed(2)} BOB, NO podrás venderle de inmediato a ${opp.buyer.nickName}.`);
        console.log(`    ⚠️ Solo procede si ya cuentas con al menos \x1b[33m\x1b[1m${l.sell.minUsdt.toFixed(2)} USDT\x1b[0m en tu balance previo.`);
    }

    // Proyección de ganancias
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[33m\x1b[1m' + ` 📊 PROYECCIÓN DINÁMICA DE BENEFICIO (Fórmula: b = a - ${BINANCE_TOTAL_FEE_USDT}$):` + '\x1b[0m');
    if (isCompat) {
        console.log(`    - Con monto ejecutable (${pDyn.a} $ USDT):      Ganancia Neta: ${formatProfit(pDyn.netProfitBob)} (a = ${pDyn.a} $ ➔ b = ${pDyn.b} $)`);
        console.log(`    - Si rotas tus ${MAX_CAPITAL_USDT} $ completos:            Ganancia Neta: ${formatProfit(pMax.netProfitBob)} (a = ${pMax.a} $ ➔ b = ${pMax.b} $)`);
        console.log(`    - Si rotas 1000 Bs (~${p1000.a} $ USDT):              Ganancia Neta: ${formatProfit(p1000.netProfitBob)} (a = ${p1000.a} $ ➔ b = ${p1000.b} $)`);
        if (opp.profit100) {
            console.log(`    - Si rotas 100 Bs (~${opp.profit100.a} $ USDT):                Ganancia Neta: ${formatProfit(opp.profit100.netProfitBob)} (Spread insuficiente para 100 Bs)`);
        }
    } else {
        console.log(`    - Con rotación máxima (${MAX_CAPITAL_USDT} $ USDT):       Ganancia Neta: ${formatProfit(pMax.netProfitBob)} (si cumples límites)`);
        console.log(`    - Si rotas 1000 Bs (~${p1000.a} $ USDT):              Ganancia Neta: ${formatProfit(p1000.netProfitBob)} (si cumples límites)`);
    }

    // Disparador semi-automático
    const actionTradeAmount = opp.dynamicTradeUsdt || (isCompat ? l.suggestedTradeUsdt : DEFAULT_TRADE_USDT);
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[42m\x1b[30m\x1b[1m' + ' ⌨️  DISPARADOR RÁPIDO BINANCE:                                                         ' + '\x1b[0m');
    console.log(` 👉 Presiona \x1b[32m\x1b[1m[c]\x1b[0m o \x1b[32m\x1b[1m[Enter]\x1b[0m: COMPRAR automáticamente ${actionTradeAmount} USDT a ${opp.seller.nickName}`);
    console.log(` 👉 Presiona \x1b[36m\x1b[1m[m]\x1b[0m:         Marcar como COMPRADO MANUALMENTE en Binance (registra en CSV con "SI")`);
    console.log(` 👉 Presiona \x1b[31m\x1b[1m[v]\x1b[0m:         VENDER automáticamente ${actionTradeAmount} USDT a ${opp.buyer.nickName}`);
    console.log(` 👉 Presiona \x1b[35m\x1b[1m[i]\x1b[0m:         IGNORAR a "${opp.seller.nickName}" (añade a lista negra de Binance)`);
    console.log(` 👉 Presiona \x1b[33m\x1b[1m[b]\x1b[0m:         BLOQUEAR usuario / gestionar lista negra de Binance`);
    console.log(' 👉 Presiona \x1b[33m\x1b[1m[s]\x1b[0m:         Activar / Silenciar sonido (Switch Mute)');
    console.log(' 👉 Presiona \x1b[33m\x1b[1m[Espacio]\x1b[0m:   Ignorar y continuar escaneando');
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[44m\x1b[37m\x1b[1m' + ' 🔗 ENLACES DIRECTOS MANUALES EN BINANCE:                                              ' + '\x1b[0m');
    console.log(' 1️⃣ Comprar: \x1b[36m\x1b[4mhttps://p2p.binance.com/es/trade/all-payments/USDT?fiat=BOB&tradeType=buy\x1b[0m');
    console.log(' 2️⃣ Vender:  \x1b[36m\x1b[4mhttps://p2p.binance.com/es/trade/all-payments/USDT?fiat=BOB&tradeType=sell\x1b[0m\n');
}

let isPromptingBlock = false;
let lastRawSellers = [];
let lastRawBuyers = [];

/**
 * Despliega el menú interactivo para bloquear o desbloquear anunciantes en el Radar Binance
 */
async function triggerBlockMerchantPrompt() {
    isPromptingBlock = true;
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }

    console.clear();
    const currentIgnored = loadIgnoredMerchants();
    console.log('========================================================================================');
    console.log(' 🚫 GESTIÓN DE ANUNCIANTES BLOQUEADOS / LISTA NEGRA (RADAR BINANCE)');
    console.log('========================================================================================');
    console.log(`📋 Anunciantes actualmente bloqueados en ignored_merchants_binance.json (${currentIgnored.length}):`);
    if (currentIgnored.length === 0) {
        console.log('   (Ningún comerciante bloqueado en Binance por el momento)');
    } else {
        currentIgnored.forEach((nick, idx) => {
            console.log(`   [${idx + 1}] ${nick} \x1b[31m\x1b[1m(bloq)\x1b[0m`);
        });
    }
    console.log('----------------------------------------------------------------------------------------');

    // Candidatos sugeridos de los últimos anuncios vistos en el radar
    const candidates = [];
    (lastRawSellers || []).slice(0, 6).forEach(s => {
        const n = (s?.advertiser?.nickName || '').trim();
        const p = parseFloat(s?.adv?.price || 0).toFixed(2);
        if (n && !candidates.map(c => c.name.toUpperCase()).includes(n.toUpperCase())) {
            candidates.push({ name: n, type: 'Vendedor', price: p });
        }
    });
    (lastRawBuyers || []).slice(0, 6).forEach(b => {
        const n = (b?.advertiser?.nickName || '').trim();
        const p = parseFloat(b?.adv?.price || 0).toFixed(2);
        if (n && !candidates.map(c => c.name.toUpperCase()).includes(n.toUpperCase())) {
            candidates.push({ name: n, type: 'Comprador', price: p });
        }
    });

    if (candidates.length > 0) {
        console.log('💡 Anunciantes detectados en Binance en el último escaneo (escribe su número para bloquear):');
        candidates.forEach((cand, idx) => {
            const isAlreadyBlocked = currentIgnored.includes(cand.name.toUpperCase());
            const tag = isAlreadyBlocked ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
            console.log(`   [#${idx + 1}] ${cand.type.padEnd(9)}: ${cand.name.padEnd(20)} (${cand.price} BOB)${tag}`);
        });
        console.log('----------------------------------------------------------------------------------------');
    }

    console.log('👉 Instrucciones:');
    console.log('   • Escribe el número [#1, #2...] para bloquear al anunciante sugerido.');
    console.log('   • O escribe el NOMBRE del anunciante que deseas bloquear en Binance.');
    console.log('   • Puedes escribir varios separados por comas (ej: User1, User2).');
    console.log('   • Para DESBLOQUEAR a alguien de la lista, antepón un guion: -NOMBRE (ej: -Comerciante).');
    console.log('   • Presiona [ENTER] vacío para volver al radar sin hacer cambios.\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('✏️  ¿A quién deseas bloquear/desbloquear en Binance?: ', (answer) => {
        rl.close();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        isPromptingBlock = false;

        const input = (answer || '').trim();
        if (!input) {
            console.log('\n🔙 Volviendo al radar...');
            return;
        }

        const num = parseInt(input, 10);
        if (!isNaN(num) && num >= 1 && num <= candidates.length) {
            const target = candidates[num - 1].name;
            addIgnoredMerchant(target);
            console.log(`\n🚫 ¡Comerciante "${target}" AGREGADO a la lista de bloqueados de Binance!`);
            console.log('   Se ha guardado en ignored_merchants_binance.json y ya no se mostrará en el radar.');
        } else if (input.startsWith('-')) {
            const toRemove = input.slice(1).trim();
            removeIgnoredMerchant(toRemove);
            console.log(`\n🔓 Comerciante "${toRemove}" DESBLOQUEADO de Binance.`);
        } else {
            const names = input.split(',').map(n => n.trim()).filter(Boolean);
            names.forEach(name => {
                addIgnoredMerchant(name);
                console.log(`\n🚫 ¡Comerciante "${name}" AGREGADO a la lista de bloqueados de Binance!`);
            });
            console.log('   Se ha guardado en ignored_merchants_binance.json y ya no se mostrará en el radar.');
        }
    });
}

/**
 * Bucle Principal de Escaneo de Alta Frecuencia para Binance
 */
async function startBinanceGapHunterLoop() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', async (str, key) => {
        if (isPromptingBlock) return; // Ignorar eventos si estamos en el prompt de bloqueo

        if ((key.ctrl && key.name === 'c') || key.name === 'q') {
            console.log('\n👋 Cerrando Radar Binance P2P. ¡Hasta pronto!');
            process.exit(0);
        }
        // Tecla [b]: Bloquear comerciante / Gestionar lista negra
        if (key.name === 'b' && !isExecutingOrder) {
            await triggerBlockMerchantPrompt();
            return;
        }
        // Tecla [s]: Silenciar / Activar sonido (Switch Mute)
        if (key.name === 's' || str === 's' || str === 'S') {
            const muted = toggleSoundMute();
            console.log(muted ? '\n🔇 [SONIDO BINANCE]: SILENCIADO (Mute ON)' : '\n🔊 [SONIDO BINANCE]: ACTIVADO (Mute OFF - Alarm02)');
            return;
        }

        // Teclas [+] y [-]: Ajustar el capital máximo en caliente (+/- 20 USDT)
        if (str === '+' || key.name === 'up') {
            MAX_CAPITAL_USDT += 20;
            console.log(`\n💰 [CAPITAL MÁXIMO BINANCE AUMENTADO]: ${MAX_CAPITAL_USDT} $ USDT`);
            return;
        }
        if (str === '-' || key.name === 'down') {
            MAX_CAPITAL_USDT = Math.max(10, MAX_CAPITAL_USDT - 20);
            console.log(`\n💰 [CAPITAL MÁXIMO BINANCE REDUCIDO]: ${MAX_CAPITAL_USDT} $ USDT`);
            return;
        }

        if (key.name === 'p' || key.name === 'space') {
            isPaused = !isPaused;
            console.log(isPaused ? '\n⏸️ Radar en PAUSA. Presiona [Espacio] para reanudar.' : '\n▶️ Reanudando Radar...');
            return;
        }

        // Si hay una brecha activa y el usuario confirma compra o venta
        if (currentActiveGap && !isExecutingOrder) {
            // Teclas que disparan órdenes reales (c, v, Enter, m): protegidas por cooldown
            const isTradeKey = key.name === 'c' || key.name === 'v' || key.name === 'return' || key.name === 'm';
            if (isTradeKey) {
                const cooldownRemain = ORDER_COOLDOWN_MS - (Date.now() - lastOrderTime);
                if (cooldownRemain > 0) {
                    console.log(`\n⏸️ [COOLDOWN ACTIVO]: Espera ${Math.ceil(cooldownRemain / 1000)}s antes de disparar otra orden. (Tecla "${key.name}" ignorada por seguridad.)`);
                    return;
                }
            }

            // Snapshot del gap ANTES de ejecutar, y limpiar currentActiveGap inmediatamente
            // para que los eventos encolados durante Playwright no se disparen contra el mismo gap.
            const gap = currentActiveGap;
            const tradeAmount = gap.limits?.suggestedTradeUsdt || DEFAULT_TRADE_USDT;

            // Helper: ejecuta una orden Taker con guards + registro + cooldown
            const runTradeAction = async ({ side, merchantNick, price, actionLabel }) => {
                isExecutingOrder = true;
                isPaused = true;
                lastOrderTime = Date.now();
                currentActiveGap = null;

                if (!gap.limits?.hasOverlap) {
                    console.log('\n⚠️ [ADVERTENCIA]: Los límites no son directamente compatibles.');
                    console.log(`Motivo: ${gap.limits?.reason}`);
                }
                console.log(`\n\n⚡ [ACCION DISPARADA]: Iniciando ${actionLabel} semi-automática de ${tradeAmount} USDT en Binance...`);

                try {
                    await executeBinanceTakerOrder({ side, merchantNick, price, amountUsdt: tradeAmount });

                    logOpportunity(gap, { executed: true, side, amountUsdt: tradeAmount });

                    recordTradeInHistory({
                        type: side === 'BUY' ? 'COMPRA' : 'VENTA',
                        cryptoAmount: tradeAmount,
                        price,
                        fiatAmount: tradeAmount * price,
                        counterparty: merchantNick
                    });

                    console.log(`\n✅ [REGISTRADO EN CSV]: ${actionLabel} registrada (${tradeAmount} USDT a ${price.toFixed(2)} BOB).`);
                } catch (e) {
                    console.error(`Error al ejecutar pedido ${side} en Binance:`, e.message);
                } finally {
                    isExecutingOrder = false;
                    isPaused = false;
                    lastOrderTime = Date.now();
                    console.log(`\n▶️ Radar reanudado. Cooldown ${ORDER_COOLDOWN_MS / 1000}s activo para prevenir órdenes dobles.`);
                }
            };

            if (key.name === 'c' || key.name === 'return') {
                await runTradeAction({
                    side: 'BUY',
                    merchantNick: gap.seller.nickName,
                    price: gap.buyPrice,
                    actionLabel: 'compra'
                });
                return;
            }

            if (key.name === 'v') {
                await runTradeAction({
                    side: 'SELL',
                    merchantNick: gap.buyer.nickName,
                    price: gap.sellPrice,
                    actionLabel: 'venta'
                });
                return;
            }

            // Tecla [m]: Marcar compra manual (sin ejecutar Playwright, solo registro)
            if (key.name === 'm') {
                lastOrderTime = Date.now();
                currentActiveGap = null;
                logOpportunity(gap, { executed: true, side: 'BUY', amountUsdt: tradeAmount });
                recordTradeInHistory({
                    type: 'COMPRA',
                    cryptoAmount: tradeAmount,
                    price: gap.buyPrice,
                    fiatAmount: tradeAmount * gap.buyPrice,
                    counterparty: gap.seller.nickName
                });
                console.log(`\n✅ [MARCADO MANUAL EN CSV]: Compra registrada (${tradeAmount} USDT a ${gap.buyPrice.toFixed(2)} BOB vs Pico ${gap.sellPrice.toFixed(2)} BOB).`);
                return;
            }

            // Tecla [i]: Ignorar anunciante activo
            if (key.name === 'i') {
                const sellerNick = gap.seller.nickName;
                addIgnoredMerchant(sellerNick);
                console.log(`\n🚫 [IGNORADO]: Comerciante "${sellerNick}" añadido a la lista de ignorados de Binance.`);
                console.log('🔇 La alarma para este comerciante ha sido silenciada permanentemente.');
                currentActiveGap = null;
                return;
            }
        }
    });

    console.clear();
    console.log('🚀 INICIANDO RADAR CAZADOR DE BRECHAS PURAS BINANCE P2P (TAKER)...');
    console.log(`⚡ Tasa de refresco: Cada ${REFRESH_INTERVAL_MS}ms | Capital Dinámico: ${MAX_CAPITAL_USDT} $ USDT | Fee Fijo: $${BINANCE_TOTAL_FEE_USDT} | Ganancia Neta: > 0 BOB`);
    console.log(`🛡️  Filtro de límites estrictos: ${ONLY_COMPATIBLE_LIMITS ? 'ACTIVADO (solo brechas 100% compatibles)' : 'DESACTIVADO (muestra todas con advertencia)'}\n`);

    while (true) {
        if (!isPaused && !isExecutingOrder) {
            scanCount++;
            const cycleStart = Date.now();

            try {
                // Consultar en paralelo API pública de Binance P2P
                const [sellers, buyers] = await Promise.all([
                    fetchBinanceP2P({ tradeType: 'BUY', rows: 10 }), // Vendedores de USDT (donde compramos)
                    fetchBinanceP2P({ tradeType: 'SELL', rows: 10 }) // Compradores de USDT (donde vendemos)
                ]);

                lastRawSellers = sellers || [];
                lastRawBuyers = buyers || [];
                const ignoredList = loadIgnoredMerchants();

                const activeSellers = filterIgnoredMerchants(sellers);
                const activeBuyers = filterIgnoredMerchants(buyers);

                const gaps = findBinanceArbitrageGaps(activeSellers, activeBuyers);
                const latency = Date.now() - cycleStart;
                const totalReqs = scanCount * 2;
                const cycleTotalTime = latency + REFRESH_INTERVAL_MS;
                const reqPerSec = cycleTotalTime > 0 ? ((2 / cycleTotalTime) * 1000).toFixed(1) : '0.0';

                const rawTopSeller = (sellers && sellers[0]) || null;
                const rawTopBuyer = (buyers && buyers[0]) || null;
                const rawTopSellerNick = (rawTopSeller?.advertiser?.nickName || '').toUpperCase();
                const rawTopBuyerNick = (rawTopBuyer?.advertiser?.nickName || '').toUpperCase();
                const isTopSellerBlocked = rawTopSellerNick && ignoredList.includes(rawTopSellerNick);
                const isTopBuyerBlocked = rawTopBuyerNick && ignoredList.includes(rawTopBuyerNick);

                const topSeller = activeSellers[0]?.adv || {};
                const topBuyer = activeBuyers[0]?.adv || {};
                const bestBuyPrice = parseFloat(topSeller.price || 0);
                const bestSellPrice = parseFloat(topBuyer.price || 0);
                const currentSpread = (bestSellPrice - bestBuyPrice).toFixed(3);

                console.clear();
                const nowTime = new Date().toLocaleTimeString('es-BO', { hour12: false });
                console.log('========================================================================================');
                console.log(` ⚡ RADAR CAZADOR DE BRECHAS BINANCE P2P (TAKER ➔ TAKER) [${nowTime}]`);
                console.log('========================================================================================');
                console.log(` 📡 Peticiones: #${totalReqs} (2 por ciclo · ~${reqPerSec} req/s) │ ⚡ Latencia Red: ${latency}ms │ 🎯 Brechas: ${opportunitiesCount} │ 🚫 Bloqueados: ${ignoredList.length}`);
                const estCapitalBob = bestBuyPrice > 0 ? (MAX_CAPITAL_USDT * bestBuyPrice).toFixed(0) : '0';
                console.log(` 💰 Capital Máx: ${MAX_CAPITAL_USDT} $ USDT (~${estCapitalBob} Bs) │ 💸 Fee: $${BINANCE_TOTAL_FEE_USDT} │ ⏱️ Intervalo: ${REFRESH_INTERVAL_MS}ms │ 🔊 Sonido: ${isSoundMuted() ? '\x1b[31m\x1b[1mOFF (MUTE)\x1b[0m' : '\x1b[32m\x1b[1mON [Alarm02]\x1b[0m'}`);
                console.log(' ⌨️  [b]: Bloquear | [s]: Mute | [+/-]: Ajustar Capital ($) | [Espacio]: Pausa | [c]: Comprar | [v]: Vender | [q]: Salir');
                console.log('----------------------------------------------------------------------------------------');

                if (isTopSellerBlocked) {
                    console.log(` 🚫 \x1b[33m\x1b[1m[OMITIDO]: Vendedor "${rawTopSeller?.advertiser?.nickName} (bloq)" a ${parseFloat(rawTopSeller?.adv?.price || 0).toFixed(2)} BOB está en tu lista negra de Binance. Se salta automáticamente.\x1b[0m`);
                }
                if (isTopBuyerBlocked) {
                    console.log(` 🚫 \x1b[33m\x1b[1m[OMITIDO]: Comprador "${rawTopBuyer?.advertiser?.nickName} (bloq)" a ${parseFloat(rawTopBuyer?.adv?.price || 0).toFixed(2)} BOB está en tu lista negra de Binance. Se salta automáticamente.\x1b[0m`);
                }
                if (isTopSellerBlocked || isTopBuyerBlocked) {
                    console.log('----------------------------------------------------------------------------------------');
                }

                if (gaps.length > 0) {
                    opportunitiesCount++;
                    lastAlertTime = nowTime;
                    currentActiveGap = gaps[0];
                    renderBigGapAlert(currentActiveGap, nowTime);
                    logOpportunity(currentActiveGap);
                    console.log('----------------------------------------------------------------------------------------');
                } else {
                    currentActiveGap = null;
                    radarLogger.markNoGap();  // emite CLOSE si había un gap activo trackeado
                    if (lastAlertTime) {
                        console.log(` ℹ️  Última brecha cazada a las: ${lastAlertTime}`);
                        console.log('----------------------------------------------------------------------------------------');
                    }
                }

                console.log(' 🟢 ANUNCIOS PARA VENDER USDT (Compradores en Binance):');
                (buyers || []).slice(0, 5).forEach((b, i) => {
                    const nickRaw = b.advertiser?.nickName || 'N/A';
                    const isBloq = ignoredList.includes(nickRaw.toUpperCase());
                    const bloqTag = isBloq ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
                    const priceCol = isBloq ? '\x1b[90m' : '\x1b[32m\x1b[1m';
                    const price = parseFloat(b.adv?.price || 0).toFixed(2);
                    console.log(`   [#${i + 1}] ${(nickRaw + bloqTag).padEnd(22, ' ')} │ ${priceCol}${price} BOB\x1b[0m │ Límites: ${(b.adv?.minSingleTransAmount || '0').padStart(7, ' ')} a ${(b.adv?.maxSingleTransAmount || '0').padStart(9, ' ')} Bs │ Éxito: ${((b.advertiser?.monthFinishRate || 0) * 100).toFixed(0)}%`);
                });

                console.log('\n 🔴 ANUNCIOS PARA COMPRAR USDT (Vendedores en Binance):');
                (sellers || []).slice(0, 5).forEach((s, i) => {
                    const nickRaw = s.advertiser?.nickName || 'N/A';
                    const isBloq = ignoredList.includes(nickRaw.toUpperCase());
                    const bloqTag = isBloq ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
                    const priceCol = isBloq ? '\x1b[90m' : '\x1b[31m\x1b[1m';
                    const price = parseFloat(s.adv?.price || 0).toFixed(2);
                    console.log(`   [#${i + 1}] ${(nickRaw + bloqTag).padEnd(22, ' ')} │ ${priceCol}${price} BOB\x1b[0m │ Límites: ${(s.adv?.minSingleTransAmount || '0').padStart(7, ' ')} a ${(s.adv?.maxSingleTransAmount || '0').padStart(9, ' ')} Bs │ Éxito: ${((s.advertiser?.monthFinishRate || 0) * 100).toFixed(0)}%`);
                });

                console.log('----------------------------------------------------------------------------------------');
                
                const currentProfitMax = calculateDynamicBinanceProfit({
                    buyPrice: bestBuyPrice,
                    sellPrice: bestSellPrice,
                    tradeUsdt: MAX_CAPITAL_USDT
                });

                if (currentProfitMax.isProfitable) {
                    console.log(` 🔥 RENTABLE EN BINANCE: \x1b[32m\x1b[1m+${currentProfitMax.netProfitBob.toFixed(2)} BOB netos\x1b[0m rotando tus ${MAX_CAPITAL_USDT} $ (Spread: +${currentSpread} BOB · Fee: -$${BINANCE_TOTAL_FEE_USDT} [${currentProfitMax.feeCostBob.toFixed(2)} Bs])`);
                } else if (parseFloat(currentSpread) > 0) {
                    console.log(` 🟡 NO RENTABLE (+${currentSpread} BOB/USDT): Con tus ${MAX_CAPITAL_USDT} $ da ${currentProfitMax.netProfitBob.toFixed(2)} Bs netos (necesitas spread >= ${currentProfitMax.breakEvenSpreadBob.toFixed(3)} BOB para cubrir $${BINANCE_TOTAL_FEE_USDT} fee). Alarma apagada.`);
                } else {
                    console.log(` ⚖️  Diferencial Actual: ${currentSpread} BOB (En espera de cruce donde Venta > Compra)`);
                }
                console.log(` 📁 Registro histórico acumulándose en: binance_market_history.csv`);
                console.log('========================================================================================');

            } catch (err) {
                // Silencioso
            }
        }

        await new Promise(r => setTimeout(r, REFRESH_INTERVAL_MS));
    }
}

if (require.main === module) {
    startBinanceGapHunterLoop().catch(err => console.error('Error en Radar Binance:', err));
}

module.exports = {
    startBinanceGapHunterLoop,
    findBinanceArbitrageGaps,
    renderBigGapAlert
};
