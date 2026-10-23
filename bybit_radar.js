/**
 * RADAR CAZADOR DE BRECHAS PURAS BYBIT P2P (ARBITRAJE TAKER ➔ TAKER)
 * Con Ejecución Semi-Automática de Pedidos con 1 Sola Tecla.
 * 
 * Objetivo Único:
 * Monitorear continuamente los anuncios en vivo de Bybit P2P y avisar
 * INMEDIATAMENTE en cuanto el precio al que puedes VENDER USDT sea MAYOR
 * que el precio al que puedes COMPRAR USDT (Margen >= 0.02 BOB).
 * 
 * Controles Rápidos al Detectar Oportunidad:
 * - [c] o [Enter]: Comprar automáticamente 100 USDT al vendedor barato.
 * - [v]: Vender automáticamente 100 USDT al comprador caro.
 * - [Espacio] o [p]: Pausar / Ignorar.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchBybitP2P } = require('./bybit/market');
const { executeBybitTakerOrder } = require('./bybit/taker_execution');
const { playAlertSound, toggleSoundMute, isSoundMuted } = require('./utils/sound');
const { filterEligibleAds, filterIgnoredMerchants, addIgnoredMerchant, removeIgnoredMerchant, loadIgnoredMerchants } = require('./bybit/eligibility');
const { loadEnv } = require('./config');
const { createRadarLogger } = require('./utils/radar_logger');
const {
    createTradeHistoryWriter,
    createLegacyLoggerAdapter,
    installFlushOnExit,
    createCooldownGuard,
    createTradeActionRunner
} = require('./utils/radar_runtime');

const env = loadEnv();

// Archivos de historial
const HISTORY_CSV = path.join(__dirname, 'bybit_market_history.csv');
const HISTORY_JSON = path.join(__dirname, 'bybit_market_history.json');

// Configuración
let REFRESH_INTERVAL_MS = 800; // Refresco cada 800ms por defecto
let MIN_SPREAD_BOB = 0.02;     // Spread MÍNIMO (filtro bruto). La alarma final requiere además ganancia neta positiva.
let DEFAULT_TRADE_USDT = 100;  // Monto por defecto para pedidos
// Fee del taker en Bybit P2P = $0 (confirmado para taker↔taker dentro del mismo exchange).
// Overridear con --fee <X> cuando se modele arbitraje cruzado:
//   p.ej. --fee 0.50 para simular retiro BEP-20 saliendo de Bybit hacia Binance.
let BYBIT_TOTAL_FEE_USDT = 0.00;
// Alarma solo cuando la ganancia neta sea >= este valor (default 0.01 BOB para evitar ruido de redondeo).
let MIN_NET_PROFIT_BOB = 0.01;
const radarArgs = process.argv.slice(2);

// Parámetro de margen / spread mínimo (CLI o .env):
const spreadArgIdx = radarArgs.findIndex(a => a === '--spread' || a === '--min-spread' || a === '-s-min');
if (spreadArgIdx !== -1 && radarArgs[spreadArgIdx + 1] && !isNaN(parseFloat(radarArgs[spreadArgIdx + 1]))) {
    MIN_SPREAD_BOB = parseFloat(radarArgs[spreadArgIdx + 1]);
} else if (env.BYBIT_MIN_SPREAD_BOB && !isNaN(parseFloat(env.BYBIT_MIN_SPREAD_BOB))) {
    MIN_SPREAD_BOB = parseFloat(env.BYBIT_MIN_SPREAD_BOB);
}

// Fee USDT (CLI o .env):
const feeArgIdx = radarArgs.findIndex(a => a === '--fee' || a === '-f');
if (feeArgIdx !== -1 && radarArgs[feeArgIdx + 1] && !isNaN(parseFloat(radarArgs[feeArgIdx + 1]))) {
    BYBIT_TOTAL_FEE_USDT = parseFloat(radarArgs[feeArgIdx + 1]);
} else if (env.BYBIT_TOTAL_FEE_USDT && !isNaN(parseFloat(env.BYBIT_TOTAL_FEE_USDT))) {
    BYBIT_TOTAL_FEE_USDT = parseFloat(env.BYBIT_TOTAL_FEE_USDT);
}

// Ganancia neta mínima (CLI o .env):
const minProfitIdx = radarArgs.findIndex(a => a === '--min-profit' || a === '-p');
if (minProfitIdx !== -1 && radarArgs[minProfitIdx + 1] && !isNaN(parseFloat(radarArgs[minProfitIdx + 1]))) {
    MIN_NET_PROFIT_BOB = parseFloat(radarArgs[minProfitIdx + 1]);
}

let ONLY_COMPATIBLE_LIMITS = radarArgs.includes('--strict') || radarArgs.includes('--only-compatible');
let FILTER_ELIGIBLE = radarArgs.some(a => a === '--elegible' || a === '--eligible' || a === '-e') ||
                      radarArgs.includes('--elegible=on') ||
                      (radarArgs.indexOf('--elegible') !== -1 && radarArgs[radarArgs.indexOf('--elegible') + 1] === 'on');

let MAX_ACCOUNT_DAYS = 30;
const daysArgIdx = radarArgs.findIndex(a => a === '--days' || a === '-d');
if (daysArgIdx !== -1 && radarArgs[daysArgIdx + 1]) {
    MAX_ACCOUNT_DAYS = parseInt(radarArgs[daysArgIdx + 1]);
}

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
let isPromptingBlock = false;
let lastRawSellers = [];
let lastRawBuyers = [];
let scanCount = 0;
let opportunitiesCount = 0;
let lastAlertTime = null;
let currentActiveGap = null;

// Cooldown post-ejecución para prevenir disparos accidentales:
// durante los segundos que tarda Playwright en ejecutar una orden, el usuario puede
// pulsar teclas (nervios, impaciencia) que Node encola. Cuando la orden termina,
// esos eventos se procesan y pueden disparar OTRA orden si no hay un gate temporal.
const orderCooldown = createCooldownGuard({ cooldownMs: 5000 });

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
                const backupPath = path.join(__dirname, 'bybit_market_history_backup.csv');
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

// Registrar operación ejecutada en history.json para que ejercicio.js y reportes lo tengan en cuenta
// Writer compartido vía utils/radar_runtime (reemplaza ~24 líneas duplicadas)
const recordTradeInHistory = createTradeHistoryWriter({ historyFile: HISTORY_FILE, exchange: 'bybit' });

// Guardar en el historial CSV y JSON comparando Oportunidad de Compra vs Pico de Venta
// Nuevo logger centralizado (JSONL append-only + debounce por estado + flush legacy en background)
const radarLogger = createRadarLogger({
    exchange: 'bybit',
    csvPath: HISTORY_CSV,
    jsonPath: HISTORY_JSON,
    jsonlDir: __dirname,
    defaultTradeUsdt: DEFAULT_TRADE_USDT
});

// Adapter de compatibilidad + handlers de salida (vía utils/radar_runtime).
const logOpportunity = createLegacyLoggerAdapter(radarLogger);
installFlushOnExit(radarLogger);

// Runner compartido para ejecutar órdenes taker (compra/venta/marcar manual).
// Reemplaza la closure runTradeAction que estaba duplicada en ambos radars.
const tradeActionRunner = createTradeActionRunner({
    executor: executeBybitTakerOrder,
    logOpportunity,
    recordTradeInHistory,
    cooldown: orderCooldown,
    exchangeLabel: '',          // Bybit no agregaba sufijo "en Bybit" en el mensaje original
    pricePrecision: 3,          // Bybit mostraba 3 decimales (BOB)
    state: {
        setExecutingOrder: v => { isExecutingOrder = v; },
        setPaused:         v => { isPaused = v; },
        setCurrentActiveGap: v => { currentActiveGap = v; }
    }
});

/**
 * Calcula y normaliza los límites en BOB y USDT, y evalúa el solapamiento
 */
function analyzeLimitCompatibility(buyPrice, seller, sellPrice, buyer) {
    // 1. Límites de Compra (Vendedor de USDT donde nosotros compramos)
    const buyMinBob = parseFloat(seller.minAmount) || 0;
    const buyMaxBobRaw = parseFloat(seller.maxAmount) || 0;
    const sellerAvailUsdt = parseFloat(seller.lastQuantity) || 0;

    const buyMinUsdt = buyPrice > 0 ? buyMinBob / buyPrice : 0;
    let buyMaxUsdt = buyPrice > 0 ? buyMaxBobRaw / buyPrice : 0;
    if (sellerAvailUsdt > 0 && sellerAvailUsdt < buyMaxUsdt) {
        buyMaxUsdt = sellerAvailUsdt;
    }
    const buyMaxBob = buyMaxUsdt * buyPrice;

    // 2. Límites de Venta (Comprador de USDT donde nosotros vendemos)
    const sellMinBob = parseFloat(buyer.minAmount) || 0;
    const sellMaxBobRaw = parseFloat(buyer.maxAmount) || 0;
    const buyerAvailUsdt = parseFloat(buyer.lastQuantity) || 0;

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
    let suggestedTradeUsdt = DEFAULT_TRADE_USDT;

    if (hasOverlap) {
        if (DEFAULT_TRADE_USDT < overlapMinUsdt) {
            suggestedTradeUsdt = parseFloat(overlapMinUsdt.toFixed(2));
        } else if (DEFAULT_TRADE_USDT > overlapMaxUsdt) {
            suggestedTradeUsdt = parseFloat(overlapMaxUsdt.toFixed(2));
        } else {
            suggestedTradeUsdt = DEFAULT_TRADE_USDT;
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
 * Encuentra brechas donde Precio_Venta > Precio_Compra
 */
function findArbitrageGaps(sellers = [], buyers = []) {
    const gaps = [];

    const activeSellers = FILTER_ELIGIBLE ? filterEligibleAds(sellers, { maxDays: MAX_ACCOUNT_DAYS }) : filterIgnoredMerchants(sellers);
    const activeBuyers = FILTER_ELIGIBLE ? filterEligibleAds(buyers, { maxDays: MAX_ACCOUNT_DAYS }) : filterIgnoredMerchants(buyers);

    for (const s of activeSellers.slice(0, 8)) {
        const buyPrice = parseFloat(s.price);
        for (const b of activeBuyers.slice(0, 8)) {
            const sellPrice = parseFloat(b.price);

            if (sellPrice > buyPrice && buyPrice > 0) {
                const spread = parseFloat((sellPrice - buyPrice).toFixed(3));
                // Filtro bruto por spread mínimo (barato de calcular)
                if (spread >= MIN_SPREAD_BOB) {
                    const marginPercent = ((spread / buyPrice) * 100).toFixed(2);
                    const limits = analyzeLimitCompatibility(buyPrice, s, sellPrice, b);

                    // Si el filtro de solo compatibles está activo, saltar los incompatibles
                    if (ONLY_COMPATIBLE_LIMITS && !limits.hasOverlap) {
                        continue;
                    }

                    // Cálculo neto REAL descontando fees (análogo a binance_radar)
                    const tradeUsdt = limits.suggestedTradeUsdt || DEFAULT_TRADE_USDT;
                    const grossProfitBob = spread * tradeUsdt;
                    const feeCostBob = BYBIT_TOTAL_FEE_USDT * sellPrice;
                    const netProfitBob = parseFloat((grossProfitBob - feeCostBob).toFixed(2));
                    const breakEvenSpreadBob = tradeUsdt > 0 ? parseFloat((feeCostBob / tradeUsdt).toFixed(4)) : 0;
                    const isProfitable = netProfitBob >= MIN_NET_PROFIT_BOB;

                    gaps.push({
                        seller: s,
                        buyer: b,
                        buyPrice: buyPrice,
                        sellPrice: sellPrice,
                        spread: spread,
                        marginPercent: marginPercent,
                        limits: limits,
                        grossProfitBob: parseFloat(grossProfitBob.toFixed(2)),
                        feeCostBob: parseFloat(feeCostBob.toFixed(2)),
                        netProfitBob: netProfitBob,
                        breakEvenSpreadBob: breakEvenSpreadBob,
                        isProfitable: isProfitable,
                        detail: `Comprar a ${buyPrice.toFixed(3)} BOB y vender a ${sellPrice.toFixed(3)} BOB`
                    });
                }
            }
        }
    }

    // Ordenar: primero los que tienen límites compatibles (solapamiento), y luego por mayor spread
    gaps.sort((a, b) => {
        if (a.limits.hasOverlap && !b.limits.hasOverlap) return -1;
        if (!a.limits.hasOverlap && b.limits.hasOverlap) return 1;
        return b.spread - a.spread;
    });

    return gaps;
}

/**
 * Renderizado de Alerta Visual Gigante
 */
function renderBigGapAlert(opp, nowTime) {
    process.stdout.write('\x07\x07\x07\x07');

    const l = opp.limits;
    const isCompat = l.hasOverlap;

    // Reproducir alerta sonora potente Bybit (Alarm01.wav)
    if (isCompat) {
        playAlertSound({ type: 'alarm', platform: 'bybit' }); // Alarma fuerte de Windows para Bybit (Alarm01.wav)
    } else {
        playAlertSound({ type: 'siren', platform: 'bybit' }); // Sirena de atención Bybit
    }

    console.log('\n');
    if (isCompat) {
        console.log('\x1b[42m\x1b[30m\x1b[1m' + '╔══════════════════════════════════════════════════════════════════════════════════════╗' + '\x1b[0m');
        console.log('\x1b[42m\x1b[30m\x1b[1m' + '║  🚨🚨🚨 ¡BRECHA DETECTADA Y LÍMITES 100% COMPATIBLES EN BYBIT! 🚨🚨🚨                 ║'.padEnd(89, ' ') + '\x1b[0m');
        console.log('\x1b[42m\x1b[30m\x1b[1m' + '╚══════════════════════════════════════════════════════════════════════════════════════╝' + '\x1b[0m');
    } else {
        console.log('\x1b[41m\x1b[37m\x1b[1m' + '╔══════════════════════════════════════════════════════════════════════════════════════╗' + '\x1b[0m');
        console.log('\x1b[41m\x1b[37m\x1b[1m' + '║  ⚠️⚠️⚠️ ¡BRECHA DETECTADA PERO LÍMITES INCOMPATIBLES (SIN SOLAPAMIENTO)! ⚠️⚠️⚠️       ║'.padEnd(89, ' ') + '\x1b[0m');
        console.log('\x1b[41m\x1b[37m\x1b[1m' + '╚══════════════════════════════════════════════════════════════════════════════════════╝' + '\x1b[0m');
    }

    console.log('\x1b[32m\x1b[1m' + `\n 💰 GANANCIA LIMPIA:       +${opp.spread.toFixed(3)} BOB por USDT (+${opp.marginPercent}% de margen directo)` + '\x1b[0m');
    console.log('----------------------------------------------------------------------------------------');
    
    // Paso 1: Compra
    console.log('\x1b[1m' + ' 🟢 PASO 1 (COMPRAR USDT BARATO):' + '\x1b[0m');
    console.log(`    - Comerciante:   \x1b[32m\x1b[1m${opp.seller.nickName}\x1b[0m (Tasa éxito: ${opp.seller.recentExecuteRate}%)`);
    console.log(`    - Precio Compra: \x1b[32m\x1b[1m${opp.buyPrice.toFixed(3)} BOB\x1b[0m`);
    console.log(`    - Límites BOB:   ${l.buy.minBob.toFixed(2)} BOB a ${l.buy.maxBob.toFixed(2)} BOB`);
    console.log(`    - Límites USDT:  \x1b[36m\x1b[1m${l.buy.minUsdt.toFixed(2)} $ a ${l.buy.maxUsdt.toFixed(2)} $ USDT\x1b[0m (Disp: ${l.buy.availUsdt} USDT)`);
    console.log(`    - Pagos:         Codes [${Array.isArray(opp.seller.payments) ? opp.seller.payments.join(', ') : 'N/A'}]`);

    // Paso 2: Venta
    console.log('\x1b[1m' + '\n 🔴 PASO 2 (VENDER USDT CARO DE INMEDIATO):' + '\x1b[0m');
    console.log(`    - Comerciante:   \x1b[31m\x1b[1m${opp.buyer.nickName}\x1b[0m (Tasa éxito: ${opp.buyer.recentExecuteRate}%)`);
    console.log(`    - Precio Venta:  \x1b[31m\x1b[1m${opp.sellPrice.toFixed(3)} BOB\x1b[0m  \x1b[33m(¡+${opp.spread.toFixed(3)} Bs más caro!)\x1b[0m`);
    console.log(`    - Límites BOB:   ${l.sell.minBob.toFixed(2)} BOB a ${l.sell.maxBob.toFixed(2)} BOB`);
    console.log(`    - Límites USDT:  \x1b[36m\x1b[1m${l.sell.minUsdt.toFixed(2)} $ a ${l.sell.maxUsdt.toFixed(2)} $ USDT\x1b[0m (Disp: ${l.sell.availUsdt} USDT)`);
    console.log(`    - Pagos:         Codes [${Array.isArray(opp.buyer.payments) ? opp.buyer.payments.join(', ') : 'N/A'}]`);

    // Bloque de Verificación de Límites y Compatibilidad
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[1m' + ' 🔍 VERIFICACIÓN DE LÍMITES Y COMPATIBILIDAD:' + '\x1b[0m');
    if (isCompat) {
        console.log(` \x1b[32m\x1b[1m  ✅ ¡LÍMITES 100% COMPATIBLES Y SOLAPADOS!\x1b[0m`);
        console.log(`    - Rango que puedes arbitrar:  \x1b[32m\x1b[1mDe ${l.overlapMinUsdt.toFixed(2)} $ a ${l.overlapMaxUsdt.toFixed(2)} $ USDT\x1b[0m`);
        console.log(`    - Equivalente en Bolivianos:  De ${l.overlapMinBob.toFixed(2)} Bs a ${l.overlapMaxBob.toFixed(2)} Bs`);
        console.log(`    - Monto sugerido para orden:  \x1b[33m\x1b[1m${l.suggestedTradeUsdt} USDT\x1b[0m`);
        console.log(`    - Ganancia neta con este monto: \x1b[32m\x1b[1m+${(opp.spread * l.suggestedTradeUsdt).toFixed(2)} BOB\x1b[0m`);
    } else {
        console.log(` \x1b[31m\x1b[1m  🚨 ¡ATENCIÓN: LÍMITES INCOMPATIBLES (SIN SOLAPAMIENTO DIRECTO)!\x1b[0m`);
        console.log(`    ⛔ ${l.reason}`);
        console.log(`    ⚠️ \x1b[33mPELIGRO:\x1b[0m Si compras a ${opp.buyPrice.toFixed(3)} BOB, NO podrás venderle de inmediato a ${opp.buyer.nickName}.`);
        console.log(`    ⚠️ Solo procede si ya cuentas con al menos \x1b[33m\x1b[1m${l.sell.minUsdt.toFixed(2)} USDT\x1b[0m en tu balance previo.`);
    }

    // Proyección de ganancias
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[33m\x1b[1m' + ' 📊 PROYECCIÓN DE BENEFICIO:' + '\x1b[0m');
    if (isCompat) {
        console.log(`    - Con mínimo (${l.overlapMinUsdt.toFixed(2)} USDT):    Ganancia de \x1b[32m\x1b[1m+${(opp.spread * l.overlapMinUsdt).toFixed(2)} Bs\x1b[0m`);
        console.log(`    - Con sugerido (${l.suggestedTradeUsdt} USDT):   Ganancia de \x1b[32m\x1b[1m+${(opp.spread * l.suggestedTradeUsdt).toFixed(2)} Bs\x1b[0m`);
        console.log(`    - Con máximo (${l.overlapMaxUsdt.toFixed(2)} USDT):    Ganancia de \x1b[32m\x1b[1m+${(opp.spread * l.overlapMaxUsdt).toFixed(2)} Bs\x1b[0m`);
    } else {
        console.log(`    - Si mueves 100 USDT:  Ganancia proyectada de +${(opp.spread * 100).toFixed(2)} Bs (si cumples límites)`);
        console.log(`    - Si mueves 300 USDT:  Ganancia proyectada de +${(opp.spread * 300).toFixed(2)} Bs (si cumples límites)`);
    }

    // Disparador semi-automático
    const actionTradeAmount = isCompat ? l.suggestedTradeUsdt : DEFAULT_TRADE_USDT;
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[43m\x1b[30m\x1b[1m' + ' ⌨️  DISPARADOR RÁPIDO BYBIT:                                                           ' + '\x1b[0m');
    console.log(` 👉 Presiona \x1b[32m\x1b[1m[c]\x1b[0m o \x1b[32m\x1b[1m[Enter]\x1b[0m: COMPRAR automáticamente ${actionTradeAmount} USDT a ${opp.seller.nickName}`);
    console.log(` 👉 Presiona \x1b[36m\x1b[1m[m]\x1b[0m:         Marcar como COMPRADO MANUALMENTE en Bybit (registra en CSV con "SI")`);
    console.log(` 👉 Presiona \x1b[31m\x1b[1m[v]\x1b[0m:         VENDER automáticamente ${actionTradeAmount} USDT a ${opp.buyer.nickName}`);
    console.log(` 👉 Presiona \x1b[35m\x1b[1m[i]\x1b[0m:         IGNORAR a "${opp.seller.nickName}" (si no eres elegible o exige requisitos)`);
    console.log(` 👉 Presiona \x1b[33m\x1b[1m[b]\x1b[0m:         BLOQUEAR usuario / gestionar lista negra`);
    console.log(' 👉 Presiona \x1b[33m\x1b[1m[s]\x1b[0m:         Activar / Silenciar sonido (Switch Mute)');
    console.log(' 👉 Presiona \x1b[33m\x1b[1m[Espacio]\x1b[0m:   Pausar / continuar');
    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[44m\x1b[37m\x1b[1m' + ' 🔗 ENLACES DIRECTOS MANUALES EN BYBIT:                                                ' + '\x1b[0m');
    console.log(' 1️⃣ Comprar: \x1b[36m\x1b[4mhttps://www.bybit.com/fiat/trade/otc/?actionType=0&token=USDT&fiat=BOB\x1b[0m');
    console.log(' 2️⃣ Vender:  \x1b[36m\x1b[4mhttps://www.bybit.com/fiat/trade/otc/?actionType=1&token=USDT&fiat=BOB\x1b[0m\n');
}

/**
 * Despliega el menú interactivo para bloquear o desbloquear anunciantes en el Radar Bybit
 */
async function triggerBlockMerchantPrompt() {
    isPromptingBlock = true;
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }

    console.clear();
    const currentIgnored = loadIgnoredMerchants();
    console.log('========================================================================================');
    console.log(' 🚫 GESTIÓN DE ANUNCIANTES BLOQUEADOS / LISTA NEGRA (RADAR BYBIT)');
    console.log('========================================================================================');
    console.log(`📋 Anunciantes actualmente bloqueados en ignored_merchants.json (${currentIgnored.length}):`);
    if (currentIgnored.length === 0) {
        console.log('   (Ningún comerciante bloqueado por el momento)');
    } else {
        currentIgnored.forEach((nick, idx) => {
            console.log(`   [${idx + 1}] ${nick} \x1b[31m\x1b[1m(bloq)\x1b[0m`);
        });
    }
    console.log('----------------------------------------------------------------------------------------');

    // Candidatos sugeridos de los últimos anuncios vistos en el radar
    const candidates = [];
    (lastRawSellers || []).slice(0, 6).forEach(s => {
        const n = (s.nickName || '').trim();
        if (n && !candidates.map(c => c.name.toUpperCase()).includes(n.toUpperCase())) {
            candidates.push({ name: n, type: 'Vendedor', price: parseFloat(s.price).toFixed(3) });
        }
    });
    (lastRawBuyers || []).slice(0, 6).forEach(b => {
        const n = (b.nickName || '').trim();
        if (n && !candidates.map(c => c.name.toUpperCase()).includes(n.toUpperCase())) {
            candidates.push({ name: n, type: 'Comprador', price: parseFloat(b.price).toFixed(3) });
        }
    });

    if (candidates.length > 0) {
        console.log('💡 Anunciantes detectados en el último escaneo (escribe su número para bloquear):');
        candidates.forEach((cand, idx) => {
            const isAlreadyBlocked = currentIgnored.includes(cand.name.toUpperCase());
            const tag = isAlreadyBlocked ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
            console.log(`   [#${idx + 1}] ${cand.type.padEnd(9)}: ${cand.name.padEnd(16)} (${cand.price} BOB)${tag}`);
        });
        console.log('----------------------------------------------------------------------------------------');
    }

    console.log('👉 Instrucciones:');
    console.log('   • Escribe el número [#1, #2...] para bloquear al anunciante sugerido.');
    console.log('   • O escribe el NOMBRE del anunciante que deseas bloquear (ej: CarlosP2P).');
    console.log('   • Puedes escribir varios separados por comas (ej: Usuario1, Usuario2).');
    console.log('   • Para DESBLOQUEAR a alguien de la lista, antepón un guion: -NOMBRE (ej: -Chapaquito).');
    console.log('   • Presiona [ENTER] vacío para volver al radar sin hacer cambios.\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('✏️  ¿A quién deseas bloquear/desbloquear?: ', (answer) => {
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
            console.log(`\n🚫 ¡Comerciante "${target}" AGREGADO a la lista de bloqueados!`);
            console.log('   Se ha guardado en ignored_merchants.json y ya no se mostrará en el radar.');
        } else if (input.startsWith('-')) {
            const toRemove = input.slice(1).trim();
            removeIgnoredMerchant(toRemove);
            console.log(`\n🔓 Comerciante "${toRemove}" DESBLOQUEADO.`);
        } else {
            const names = input.split(',').map(n => n.trim()).filter(Boolean);
            names.forEach(name => {
                addIgnoredMerchant(name);
                console.log(`\n🚫 ¡Comerciante "${name}" AGREGADO a la lista de bloqueados!`);
            });
            console.log('   Se ha guardado en ignored_merchants.json y ya no se mostrará en el radar.');
        }
    });
}

/**
 * Bucle Principal de Escaneo de Alta Frecuencia
 */
async function startGapHunterLoop() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', async (str, key) => {
        if (isPromptingBlock) return; // Ignorar eventos si estamos en el prompt de bloqueo

        if ((key.ctrl && key.name === 'c') || key.name === 'q') {
            console.log('\n👋 Cerrando Radar Cazador de Brechas. ¡Hasta pronto!');
            process.exit(0);
        }

        // Tecla [s]: Silenciar / Activar sonido (Switch Mute)
        if (key.name === 's' || str === 's' || str === 'S') {
            const muted = toggleSoundMute();
            console.log(muted ? '\n🔇 [SONIDO BYBIT]: SILENCIADO (Mute ON)' : '\n🔊 [SONIDO BYBIT]: ACTIVADO (Mute OFF - Alarm01)');
            return;
        }

        // Teclas [+] y [-]: Ajustar el spread mínimo en caliente (+/- 0.005 BOB)
        if (str === '+' || key.name === 'up') {
            MIN_SPREAD_BOB = parseFloat((MIN_SPREAD_BOB + 0.005).toFixed(3));
            console.log(`\n📈 [SPREAD MÍNIMO AUMENTADO]: >= ${MIN_SPREAD_BOB} BOB/USDT`);
            return;
        }
        if (str === '-' || key.name === 'down') {
            MIN_SPREAD_BOB = Math.max(0.001, parseFloat((MIN_SPREAD_BOB - 0.005).toFixed(3)));
            console.log(`\n📉 [SPREAD MÍNIMO REDUCIDO]: >= ${MIN_SPREAD_BOB} BOB/USDT`);
            return;
        }

        // Tecla [b]: Bloquear comerciante / Gestionar lista negra
        if (key.name === 'b' && !isExecutingOrder) {
            await triggerBlockMerchantPrompt();
            return;
        }

        if (key.name === 'p' || key.name === 'space') {
            isPaused = !isPaused;
            console.log(isPaused ? '\n⏸️ Radar en PAUSA. Presiona [Espacio] para reanudar.' : '\n▶️ Reanudando Radar...');
            return;
        }

        // Alternar filtro de elegibilidad en caliente con la tecla [e]
        if (key.name === 'e') {
            FILTER_ELIGIBLE = !FILTER_ELIGIBLE;
            console.log(`\n🛡️ [FILTRO ELEGIBILIDAD]: ${FILTER_ELIGIBLE ? 'ACTIVADO (solo anuncios donde eres elegible)' : 'DESACTIVADO (escaneo tradicional completo)'}`);
            return;
        }

        // Si hay una brecha activa y el usuario confirma compra o venta
        if (currentActiveGap && !isExecutingOrder) {
            // Teclas que disparan órdenes reales (c, v, Enter, m): protegidas por cooldown
            const isTradeKey = key.name === 'c' || key.name === 'v' || key.name === 'return' || key.name === 'm';
            if (isTradeKey && orderCooldown.isActive()) {
                console.log(`\n⏸️ [COOLDOWN ACTIVO]: Espera ${Math.ceil(orderCooldown.remaining() / 1000)}s antes de disparar otra orden. (Tecla "${key.name}" ignorada por seguridad.)`);
                return;
            }

            // Snapshot del gap ANTES de ejecutar, y limpiar currentActiveGap inmediatamente
            // para que los eventos encolados durante Playwright no se disparen contra el mismo gap.
            const gap = currentActiveGap;
            const tradeAmount = gap.limits?.suggestedTradeUsdt || DEFAULT_TRADE_USDT;

            // runTradeAction compartido vía utils/radar_runtime (reemplaza ~40 líneas duplicadas)
            const runTradeAction = ({ side, merchantNick, price, actionLabel }) => tradeActionRunner({
                gap, side, merchantNick, price, actionLabel, tradeAmount
            });

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

            // Tecla [m]: Marcar que se compró manualmente en Bybit (sin ejecutar Playwright)
            if (key.name === 'm') {
                orderCooldown.stamp();
                currentActiveGap = null;
                logOpportunity(gap, { executed: true, side: 'BUY', amountUsdt: tradeAmount });
                recordTradeInHistory({
                    type: 'COMPRA',
                    cryptoAmount: tradeAmount,
                    price: gap.buyPrice,
                    fiatAmount: tradeAmount * gap.buyPrice,
                    counterparty: gap.seller.nickName
                });
                console.log(`\n✅ [MARCADO MANUAL EN CSV]: Compra registrada (${tradeAmount} USDT a ${gap.buyPrice.toFixed(3)} BOB vs Pico ${gap.sellPrice.toFixed(3)} BOB).`);
                return;
            }

            if (key.name === 'i') {
                const sellerNick = gap.seller.nickName;
                addIgnoredMerchant(sellerNick);
                console.log(`\n🚫 [IGNORADO]: Comerciante "${sellerNick}" añadido a la lista de ignorados.`);
                console.log('🔇 La alarma para este comerciante ha sido silenciada permanentemente.');
                currentActiveGap = null;
                return;
            }
        }
    });

    console.clear();
    console.log('🚀 INICIANDO RADAR CAZADOR DE BRECHAS PURAS BYBIT P2P (TAKER)...');
    console.log(`⚡ Tasa de refresco: Cada ${REFRESH_INTERVAL_MS}ms | Spread mín: >= ${MIN_SPREAD_BOB} BOB | Fee: $${BYBIT_TOTAL_FEE_USDT} | Ganancia Neta: >= ${MIN_NET_PROFIT_BOB} BOB`);
    console.log(`🛡️  Filtro estricto de límites: ${ONLY_COMPATIBLE_LIMITS ? 'ON' : 'OFF'}`);
    console.log(`🛡️  Filtro de elegibilidad: ${FILTER_ELIGIBLE ? `ON (descartando >${MAX_ACCOUNT_DAYS}d antigüedad | Ignorados: ${loadIgnoredMerchants().length})` : 'OFF'}\n`);

    while (true) {
        if (!isPaused && !isExecutingOrder) {
            scanCount++;
            const cycleStart = Date.now();

            try {
                const [sellers, buyers] = await Promise.all([
                    fetchBybitP2P({ side: '1', size: 10 }), // Vendedores de USDT (donde compramos)
                    fetchBybitP2P({ side: '0', size: 10 })  // Compradores de USDT (donde vendemos)
                ]);

                lastRawSellers = sellers || [];
                lastRawBuyers = buyers || [];
                const ignoredList = loadIgnoredMerchants();

                const activeSellers = FILTER_ELIGIBLE ? filterEligibleAds(sellers, { maxDays: MAX_ACCOUNT_DAYS }) : filterIgnoredMerchants(sellers);
                const activeBuyers = FILTER_ELIGIBLE ? filterEligibleAds(buyers, { maxDays: MAX_ACCOUNT_DAYS }) : filterIgnoredMerchants(buyers);

                const gaps = findArbitrageGaps(activeSellers, activeBuyers);
                const latency = Date.now() - cycleStart;
                const totalReqs = scanCount * 2;
                const cycleTotalTime = latency + REFRESH_INTERVAL_MS;
                const reqPerSec = cycleTotalTime > 0 ? ((2 / cycleTotalTime) * 1000).toFixed(1) : '0.0';

                const rawTopSeller = (sellers && sellers[0]) || null;
                const rawTopBuyer = (buyers && buyers[0]) || null;
                const isTopSellerBlocked = rawTopSeller && ignoredList.includes((rawTopSeller.nickName || '').toUpperCase());
                const isTopBuyerBlocked = rawTopBuyer && ignoredList.includes((rawTopBuyer.nickName || '').toUpperCase());

                const topSeller = activeSellers[0] || {};
                const topBuyer = activeBuyers[0] || {};
                const bestBuyPrice = parseFloat(topSeller.price || 0);
                const bestSellPrice = parseFloat(topBuyer.price || 0);
                const currentSpread = (bestSellPrice - bestBuyPrice).toFixed(3);

                console.clear();
                const nowTime = new Date().toLocaleTimeString('es-BO', { hour12: false });
                console.log('========================================================================================');
                console.log(` ⚡ RADAR CAZADOR DE BRECHAS BYBIT P2P (TAKER ➔ TAKER) [${nowTime}]`);
                console.log('========================================================================================');
                console.log(` 📡 Peticiones: #${totalReqs} (~${reqPerSec} req/s) │ ⚡ Latencia: ${latency}ms │ 🎯 Brechas: ${opportunitiesCount} │ 🚫 Bloqueados: ${ignoredList.length}`);
                console.log(` 🛡️ Elegibles: ${FILTER_ELIGIBLE ? 'ON' : 'OFF'} │ 📈 Spread mín: >= ${MIN_SPREAD_BOB} BOB │ 💸 Fee: $${BYBIT_TOTAL_FEE_USDT} │ ⏱️ Intervalo: ${REFRESH_INTERVAL_MS}ms │ 🔊 Sonido: ${isSoundMuted() ? '\x1b[31m\x1b[1mOFF (MUTE)\x1b[0m' : '\x1b[32m\x1b[1mON [Alarm01]\x1b[0m'}`);
                console.log(' ⌨️  [s]: Mute | [b]: Bloq | [+/-]: Spread mín | [e]: Elegibles | [c]: Comprar | [v]: Vender | [q]: Salir');
                console.log('----------------------------------------------------------------------------------------');

                if (isTopSellerBlocked) {
                    console.log(` 🚫 \x1b[33m\x1b[1m[OMITIDO]: Vendedor "${rawTopSeller.nickName} (bloq)" a ${parseFloat(rawTopSeller.price).toFixed(3)} BOB está en tu lista negra. Se salta automáticamente.\x1b[0m`);
                }
                if (isTopBuyerBlocked) {
                    console.log(` 🚫 \x1b[33m\x1b[1m[OMITIDO]: Comprador "${rawTopBuyer.nickName} (bloq)" a ${parseFloat(rawTopBuyer.price).toFixed(3)} BOB está en tu lista negra. Se salta automáticamente.\x1b[0m`);
                }
                if (isTopSellerBlocked || isTopBuyerBlocked) {
                    console.log('----------------------------------------------------------------------------------------');
                }

                // Priorizar el gap RENTABLE (netProfitBob >= MIN_NET_PROFIT_BOB).
                // Si no hay rentables pero sí hay con spread suficiente, se trackean pero sin alarma sonora.
                const profitableGaps = gaps.filter(g => g.isProfitable);
                if (profitableGaps.length > 0) {
                    opportunitiesCount++;
                    lastAlertTime = nowTime;
                    currentActiveGap = profitableGaps[0];
                    renderBigGapAlert(currentActiveGap, nowTime);
                    logOpportunity(currentActiveGap);
                    console.log('----------------------------------------------------------------------------------------');
                } else if (gaps.length > 0) {
                    // Hay brechas por spread pero ninguna cubre el fee → trackear silenciosamente
                    currentActiveGap = gaps[0];
                    logOpportunity(gaps[0]);
                } else {
                    currentActiveGap = null;
                    radarLogger.markNoGap();  // emite CLOSE si había un gap activo trackeado
                    if (lastAlertTime) {
                        console.log(` ℹ️  Última brecha cazada a las: ${lastAlertTime}`);
                        console.log('----------------------------------------------------------------------------------------');
                    }
                }

                console.log(` 🟢 ANUNCIOS PARA VENDER USDT (Compradores en Bybit)${FILTER_ELIGIBLE ? ' \x1b[33m[SOLO ELEGIBLES]\x1b[0m' : ''}:`);
                (buyers || []).slice(0, 6).forEach((b, i) => {
                    const isBloq = ignoredList.includes((b.nickName || '').toUpperCase());
                    const bloqTag = isBloq ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
                    const priceCol = isBloq ? '\x1b[90m' : '\x1b[32m\x1b[1m';
                    const price = parseFloat(b.price).toFixed(3);
                    console.log(`   [#${i + 1}] ${(b.nickName + bloqTag).padEnd(25, ' ')} │ ${priceCol}${price} BOB\x1b[0m │ Límites: ${b.minAmount.padStart(7, ' ')} a ${b.maxAmount.padStart(9, ' ')} Bs │ Éxito: ${b.recentExecuteRate}%`);
                });

                console.log(`\n 🔴 ANUNCIOS PARA COMPRAR USDT (Vendedores en Bybit)${FILTER_ELIGIBLE ? ' \x1b[33m[SOLO ELEGIBLES]\x1b[0m' : ''}:`);
                (sellers || []).slice(0, 6).forEach((s, i) => {
                    const isBloq = ignoredList.includes((s.nickName || '').toUpperCase());
                    const bloqTag = isBloq ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
                    const priceCol = isBloq ? '\x1b[90m' : '\x1b[31m\x1b[1m';
                    const price = parseFloat(s.price).toFixed(3);
                    console.log(`   [#${i + 1}] ${(s.nickName + bloqTag).padEnd(25, ' ')} │ ${priceCol}${price} BOB\x1b[0m │ Límites: ${s.minAmount.padStart(7, ' ')} a ${s.maxAmount.padStart(9, ' ')} Bs │ Éxito: ${s.recentExecuteRate}%`);
                });

                console.log('----------------------------------------------------------------------------------------');
                
                // Cálculo neto para el "diferencial actual" entre las puntas (puede diferir del gap top real)
                const _tradeUsdtCur = DEFAULT_TRADE_USDT;
                const _feeCostBobCur = BYBIT_TOTAL_FEE_USDT * bestSellPrice;
                const _netProfitCur = parseFloat((parseFloat(currentSpread) * _tradeUsdtCur - _feeCostBobCur).toFixed(2));
                const _breakEvenSpreadCur = _tradeUsdtCur > 0 ? (_feeCostBobCur / _tradeUsdtCur).toFixed(4) : '0';

                if (parseFloat(currentSpread) >= MIN_SPREAD_BOB && _netProfitCur >= MIN_NET_PROFIT_BOB) {
                    const feeTag = BYBIT_TOTAL_FEE_USDT > 0 ? ` · Fee: -$${BYBIT_TOTAL_FEE_USDT} [${_feeCostBobCur.toFixed(2)} Bs]` : '';
                    console.log(` 🔥 RENTABLE EN BYBIT: \x1b[32m\x1b[1m+${_netProfitCur.toFixed(2)} BOB netos\x1b[0m rotando ${_tradeUsdtCur} USDT (Spread: +${currentSpread} BOB${feeTag})`);
                } else if (parseFloat(currentSpread) > 0) {
                    if (BYBIT_TOTAL_FEE_USDT > 0) {
                        console.log(` 🟡 NO RENTABLE (+${currentSpread} BOB/USDT): Con ${_tradeUsdtCur} USDT da ${_netProfitCur.toFixed(2)} Bs netos (necesitas spread >= ${_breakEvenSpreadCur} BOB para cubrir $${BYBIT_TOTAL_FEE_USDT} fee). Alarma apagada.`);
                    } else {
                        console.log(` 🟡 SPREAD INSUFICIENTE: +${currentSpread} BOB/USDT (Menor al mínimo de ${MIN_SPREAD_BOB} BOB - Capital corto, sin alarma)`);
                    }
                } else {
                    console.log(` ⚖️  Diferencial Actual: ${currentSpread} BOB (En espera de cruce donde Venta > Compra)`);
                }
                console.log(` 📁 Registro histórico acumulándose en: bybit_market_history.csv`);
                console.log('========================================================================================');

            } catch (err) {
                // Silencioso
            }
        }

        await new Promise(r => setTimeout(r, REFRESH_INTERVAL_MS));
    }
}

if (require.main === module) {
    startGapHunterLoop().catch(err => console.error('Error en Radar Bybit:', err));
}

module.exports = {
    startGapHunterLoop,
    findArbitrageGaps,
    renderBigGapAlert
};