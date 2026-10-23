/**
 * RADAR VENDEDOR POR PRECIO META (TARGET SELLER) - BYBIT & BINANCE P2P
 * 
 * Objetivo:
 * Monitorear continuamente los anuncios en vivo de compradores de USDT en Bybit y Binance
 * y disparar una ALERTA SONORA POTENTE e INMEDIATA en cuanto el precio de venta en cualquiera
 * de las plataformas alcance o supere tu precio meta (por ejemplo: >= 12.00 BOB).
 * 
 * Permite ejecutar la venta semi-automática con 1 sola tecla ([v] o [Enter]) en la plataforma
 * que alcance la meta.
 * 
 * Uso:
 *   node vender.js 12.00              (Monitorea AMBAS: Bybit y Binance simultáneamente)
 *   node vender.js 12.00 --binance    (Monitorea solo Binance)
 *   node vender.js 12.00 --bybit      (Monitorea solo Bybit)
 *   node vender.js 12.05 --amount 200 (Monto a vender: 200 USDT)
 *   node vender.js 12.00 --once       (Chequeo único de prueba y salida)
 */

const readline = require('readline');
const { fetchBybitP2P } = require('./bybit/market');
const { executeBybitTakerOrder } = require('./bybit/taker_execution');
const { fetchBinanceP2P } = require('./binance/market');
const { executeBinanceTakerOrder } = require('./binance/taker_execution');
const { playAlertSound, toggleSoundMute, isSoundMuted } = require('./utils/sound');
const { filterEligibleAds } = require('./bybit/eligibility');

// Configuración inicial
let TARGET_PRICE_BOB = 12.00;     // Precio meta por defecto
let SELL_AMOUNT_USDT = 100;       // Monto de USDT a vender por defecto
let REFRESH_INTERVAL_MS = 1000;   // Refresco cada 1000ms
let PLATFORM = 'both';            // 'both' (por defecto), 'binance' o 'bybit'
let RUN_ONCE = false;

// Parsear argumentos CLI
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-?\d+(\.\d+)?$/.test(a)) {
        TARGET_PRICE_BOB = Math.abs(parseFloat(a));
    } else if (a === '-t' || a === '--target') {
        if (args[i + 1]) TARGET_PRICE_BOB = parseFloat(args[i + 1]);
    } else if (a === '-a' || a === '--amount') {
        if (args[i + 1]) SELL_AMOUNT_USDT = parseFloat(args[i + 1]);
    } else if (a === '--binance') {
        PLATFORM = 'binance';
    } else if (a === '--bybit') {
        PLATFORM = 'bybit';
    } else if (a === '--both') {
        PLATFORM = 'both';
    } else if (a === '--fast') {
        REFRESH_INTERVAL_MS = 500;
    } else if (a === '--slow') {
        REFRESH_INTERVAL_MS = 2500;
    } else if (a === '--once') {
        RUN_ONCE = true;
    }
}

// Variables de estado
let isPaused = false;
let isExecuting = false;
let scanCount = 0;
let alertCount = 0;
let lastAlertTime = null;
let currentTargetBuyer = null;

/**
 * Consulta los compradores de USDT de una plataforma específica
 */
async function getBuyersByPlatform(platformName) {
    if (platformName === 'binance') {
        try {
            const raw = await fetchBinanceP2P({ tradeType: 'SELL', rows: 8 });
            return (raw || []).map(item => {
                const adv = item.adv || {};
                const advr = item.advertiser || {};
                const price = parseFloat(adv.price || 0);
                const minBob = parseFloat(adv.minSingleTransAmount || 0);
                const maxBob = parseFloat(adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount || 0);
                const availUsdt = parseFloat(adv.tradableQuantity || adv.surplusAmount || 0);

                return {
                    platform: 'binance',
                    platformTag: 'BINANCE',
                    nickName: advr.nickName || 'Comprador Binance',
                    price: price,
                    minBob: minBob,
                    maxBob: maxBob,
                    minUsdt: price > 0 ? minBob / price : 0,
                    maxUsdt: price > 0 ? Math.min(maxBob / price, availUsdt || Infinity) : 0,
                    availUsdt: availUsdt,
                    successRate: ((advr.monthFinishRate || 0) * 100).toFixed(0),
                    payments: (adv.tradeMethods || []).map(m => m.tradeMethodName)
                };
            }).filter(b => b.price > 0);
        } catch (e) {
            return [];
        }
    } else {
        try {
            const raw = await fetchBybitP2P({ side: '0', size: 8 });
            const eligible = filterEligibleAds(raw);
            return eligible.map(item => {
                const price = parseFloat(item.price || 0);
                const minBob = parseFloat(item.minAmount || 0);
                const maxBob = parseFloat(item.maxAmount || 0);
                const availUsdt = parseFloat(item.lastQuantity || 0);

                return {
                    platform: 'bybit',
                    platformTag: 'BYBIT',
                    nickName: item.nickName || 'Comprador Bybit',
                    price: price,
                    minBob: minBob,
                    maxBob: maxBob,
                    minUsdt: price > 0 ? minBob / price : 0,
                    maxUsdt: price > 0 ? Math.min(maxBob / price, availUsdt || Infinity) : 0,
                    availUsdt: availUsdt,
                    successRate: item.recentExecuteRate ? `${item.recentExecuteRate}%` : 'N/A',
                    payments: Array.isArray(item.payments) ? item.payments : []
                };
            }).filter(b => b.price > 0);
        } catch (e) {
            return [];
        }
    }
}

/**
 * Consulta compradores de Bybit, Binance o ambas plataformas
 */
async function getTopBuyers() {
    if (PLATFORM === 'both') {
        const [bybitBuyers, binanceBuyers] = await Promise.all([
            getBuyersByPlatform('bybit'),
            getBuyersByPlatform('binance')
        ]);
        const all = [...bybitBuyers, ...binanceBuyers].sort((a, b) => b.price - a.price);
        return {
            bybit: bybitBuyers,
            binance: binanceBuyers,
            all
        };
    } else if (PLATFORM === 'binance') {
        const binanceBuyers = await getBuyersByPlatform('binance');
        return {
            bybit: [],
            binance: binanceBuyers,
            all: binanceBuyers
        };
    } else {
        const bybitBuyers = await getBuyersByPlatform('bybit');
        return {
            bybit: bybitBuyers,
            binance: [],
            all: bybitBuyers
        };
    }
}

/**
 * Renderiza la pantalla de alerta cuando se alcanza el precio meta
 */
function renderTargetReachedAlert(buyer, nowTime) {
    playAlertSound({ type: 'alarm', platform: buyer.platform });

    const totalBob = (SELL_AMOUNT_USDT * buyer.price).toFixed(2);
    const fitsMin = SELL_AMOUNT_USDT >= buyer.minUsdt;
    const fitsMax = SELL_AMOUNT_USDT <= buyer.maxUsdt;
    const limitsCompatible = fitsMin && fitsMax;
    const platName = buyer.platform.toUpperCase();

    console.log('\n');
    console.log('\x1b[42m\x1b[30m\x1b[1m' + '╔══════════════════════════════════════════════════════════════════════════════════════╗' + '\x1b[0m');
    console.log('\x1b[42m\x1b[30m\x1b[1m' + `║  🎯 ¡PRECIO META ALCANZADO EN [${platName}]! VENDER A >= ${TARGET_PRICE_BOB.toFixed(2)} BOB`.padEnd(87, ' ') + '║' + '\x1b[0m');
    console.log('\x1b[42m\x1b[30m\x1b[1m' + '╚══════════════════════════════════════════════════════════════════════════════════════╝' + '\x1b[0m');

    console.log(`\n 💰 PRECIO DE VENTA ACTUAL:  \x1b[32m\x1b[1m${buyer.price.toFixed(3)} BOB\x1b[0m en \x1b[33m\x1b[1m${platName}\x1b[0m (Supera tu meta de ${TARGET_PRICE_BOB.toFixed(2)} por +${(buyer.price - TARGET_PRICE_BOB).toFixed(3)} Bs)`);
    console.log(` 💵 MONTO A VENDER:          \x1b[33m\x1b[1m${SELL_AMOUNT_USDT} USDT\x1b[0m ➔ Recibirás: \x1b[32m\x1b[1m${totalBob} BOB\x1b[0m`);
    console.log('----------------------------------------------------------------------------------------');
    console.log(` 👤 Comprador:    \x1b[36m\x1b[1m${buyer.nickName}\x1b[0m [${platName}] (Éxito: ${buyer.successRate}%)`);
    console.log(` 💳 Pagos:        [${buyer.payments.join(', ') || 'N/A'}]`);
    console.log(` 📊 Límites BOB:  ${buyer.minBob.toFixed(2)} BOB a ${buyer.maxBob.toFixed(2)} BOB`);
    console.log(` 🪙 Límites USDT: ${buyer.minUsdt.toFixed(2)} $ a ${buyer.maxUsdt.toFixed(2)} $ USDT (Capacidad: ${buyer.availUsdt} USDT)`);
    console.log('----------------------------------------------------------------------------------------');

    // Validación de límites
    console.log(' 🔍 VERIFICACIÓN DE LÍMITES PARA TU VENTA:');
    if (limitsCompatible) {
        console.log(` \x1b[32m\x1b[1m  ✅ ¡TUS ${SELL_AMOUNT_USDT} USDT ENCAJAN PERFECTAMENTE EN LOS LÍMITES DEL COMPRADOR!\x1b[0m`);
    } else {
        if (!fitsMin) {
            const minNeededUsdt = buyer.minUsdt.toFixed(2);
            console.log(` \x1b[31m\x1b[1m  ⚠️ ATENCIÓN: Tus ${SELL_AMOUNT_USDT} USDT están por DEBAJO del mínimo de este comprador.\x1b[0m`);
            console.log(`     Mínimo requerido: ${buyer.minBob.toFixed(2)} BOB (${minNeededUsdt} USDT).`);
            console.log(`     💡 Sugerencia: Aumenta tu venta a al menos ${minNeededUsdt} USDT.`);
        }
        if (!fitsMax) {
            const maxAllowedUsdt = buyer.maxUsdt.toFixed(2);
            console.log(` \x1b[31m\x1b[1m  ⚠️ ATENCIÓN: Tus ${SELL_AMOUNT_USDT} USDT superan el MÁXIMO que este comprador recibe.\x1b[0m`);
            console.log(`     Máximo permitido: ${buyer.maxBob.toFixed(2)} BOB (${maxAllowedUsdt} USDT).`);
            console.log(`     💡 Sugerencia: Reduce tu venta a máximo ${maxAllowedUsdt} USDT.`);
        }
    }

    console.log('----------------------------------------------------------------------------------------');
    console.log('\x1b[43m\x1b[30m\x1b[1m' + ' ⌨️  DISPARADOR RÁPIDO DE VENTA:                                                        ' + '\x1b[0m');
    console.log(` 👉 Presiona \x1b[32m\x1b[1m[v]\x1b[0m o \x1b[32m\x1b[1m[Enter]\x1b[0m: VENDER automáticamente ${SELL_AMOUNT_USDT} USDT a ${buyer.nickName} en ${platName}`);
    console.log(' 👉 Presiona \x1b[33m\x1b[1m[s]\x1b[0m:         Activar / Silenciar sonido (Switch Mute)');
    console.log(' 👉 Presiona \x1b[33m\x1b[1m[Espacio]\x1b[0m:   Ignorar y seguir monitoreando');
    console.log(' 👉 Presiona \x1b[31m\x1b[1m[q]\x1b[0m:         Salir');
    console.log('----------------------------------------------------------------------------------------');
    if (buyer.platform === 'bybit') {
        console.log(' 🔗 Enlace Manual: \x1b[36m\x1b[4mhttps://www.bybit.com/fiat/trade/otc/?actionType=0&token=USDT&fiat=BOB\x1b[0m\n');
    } else {
        console.log(' 🔗 Enlace Manual: \x1b[36m\x1b[4mhttps://p2p.binance.com/es/trade/all-payments/USDT?fiat=BOB&tradeType=sell\x1b[0m\n');
    }
}

/**
 * Bucle Principal de Monitoreo
 */
async function startSellTargetLoop() {
    if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);

        process.stdin.on('keypress', async (str, key) => {
            if ((key.ctrl && key.name === 'c') || key.name === 'q') {
                console.log('\n👋 Cerrando Radar Vendedor. ¡Hasta pronto!');
                process.exit(0);
            }

            // Tecla [s]: Silenciar / Activar sonido (Switch Mute)
            if (key.name === 's' || str === 's' || str === 'S') {
                const muted = toggleSoundMute();
                console.log(muted ? '\n🔇 [SONIDO]: SILENCIADO (Mute ON)' : '\n🔊 [SONIDO]: ACTIVADO (Mute OFF)');
                return;
            }

            if (key.name === 'space' || key.name === 'p') {
                isPaused = !isPaused;
                console.log(isPaused ? '\n⏸️ Monitoreo en PAUSA. Presiona [Espacio] para reanudar.' : '\n▶️ Reanudando monitoreo...');
                return;
            }

            // Disparar venta automática si hay comprador calificado activo
            if (currentTargetBuyer && !isExecuting) {
                if (key.name === 'v' || key.name === 'return') {
                    isExecuting = true;
                    isPaused = true;

                    const plat = currentTargetBuyer.platform.toUpperCase();
                    console.log(`\n\n⚡ [ACCION DISPARADA]: Iniciando venta semi-automática en ${plat} de ${SELL_AMOUNT_USDT} USDT a ${currentTargetBuyer.nickName}...`);
                    try {
                        if (currentTargetBuyer.platform === 'binance') {
                            await executeBinanceTakerOrder({
                                side: 'SELL',
                                merchantNick: currentTargetBuyer.nickName,
                                price: currentTargetBuyer.price,
                                amountUsdt: SELL_AMOUNT_USDT
                            });
                        } else {
                            await executeBybitTakerOrder({
                                side: 'SELL',
                                merchantNick: currentTargetBuyer.nickName,
                                price: currentTargetBuyer.price,
                                amountUsdt: SELL_AMOUNT_USDT
                            });
                        }
                    } catch (err) {
                        console.error('Error al ejecutar venta:', err.message);
                    }

                    isExecuting = false;
                    isPaused = false;
                    console.log('\n▶️ Reanudando Radar Vendedor en 3 segundos...');
                    await new Promise(r => setTimeout(r, 3000));
                    return;
                }
            }
        });
    }

    const platformLabel = PLATFORM === 'both' ? 'BYBIT & BINANCE SIMULTÁNEO' : PLATFORM.toUpperCase();
    console.clear();
    console.log('🎯 INICIANDO RADAR VENDEDOR POR META P2P...');
    console.log(`📌 Plataforma: ${platformLabel}`);
    console.log(`🎯 Precio Meta: >= ${TARGET_PRICE_BOB.toFixed(2)} BOB`);
    console.log(`💵 Monto a vender: ${SELL_AMOUNT_USDT} USDT (~${(SELL_AMOUNT_USDT * TARGET_PRICE_BOB).toFixed(2)} BOB)`);
    console.log(`⚡ Tasa de refresco: Cada ${REFRESH_INTERVAL_MS}ms\n`);

    while (true) {
        if (!isPaused && !isExecuting) {
            scanCount++;
            const cycleStart = Date.now();

            try {
                const buyersData = await getTopBuyers();
                const latency = Date.now() - cycleStart;
                const allBuyers = buyersData.all || [];

                const bestOverall = allBuyers[0] || {};
                const bestOverallPrice = bestOverall.price || 0;
                const bestBybit = (buyersData.bybit || [])[0] || {};
                const bestBinance = (buyersData.binance || [])[0] || {};

                if (process.stdout.isTTY) {
                    console.clear();
                }

                const nowTime = new Date().toLocaleTimeString('es-BO', { hour12: false });
                console.log('========================================================================================');
                console.log(` 🎯 RADAR VENDEDOR P2P (${platformLabel}) │ META: >= \x1b[33m\x1b[1m${TARGET_PRICE_BOB.toFixed(2)} BOB\x1b[0m [${nowTime}]`);
                console.log('========================================================================================');
                console.log(` 📡 Ciclos: #${scanCount} │ ⚡ Latencia: ${latency}ms │ 💵 Venta: ${SELL_AMOUNT_USDT} USDT │ 🎯 Alertas: ${alertCount} │ 🔊 Sonido: ${isSoundMuted() ? '\x1b[31m\x1b[1mOFF (MUTE)\x1b[0m' : '\x1b[32m\x1b[1mON\x1b[0m'}`);
                console.log(' ⌨️  [s]: Mute/Sonido │ [v] o [Enter]: Vender a comprador │ [Espacio]: Pausar │ [q]: Salir');
                console.log('----------------------------------------------------------------------------------------');

                // Comparativa de mejores precios en vivo
                if (PLATFORM === 'both') {
                    const bybitPriceStr = bestBybit.price ? `${bestBybit.price.toFixed(3)} BOB (${bestBybit.nickName})` : 'Sin datos';
                    const binancePriceStr = bestBinance.price ? `${bestBinance.price.toFixed(3)} BOB (${bestBinance.nickName})` : 'Reconectando con Binance...';
                    console.log(` 📊 MEJORES PRECIOS EN VIVO PARA VENDER USDT:`);
                    console.log(`    • BYBIT   : \x1b[36m\x1b[1m${bybitPriceStr}\x1b[0m`);
                    console.log(`    • BINANCE : \x1b[36m\x1b[1m${binancePriceStr}\x1b[0m`);
                    console.log('----------------------------------------------------------------------------------------');
                }

                // Verificar si algún comprador alcanza o supera la meta
                const qualifyingBuyer = allBuyers.find(b => b.price >= TARGET_PRICE_BOB);

                if (qualifyingBuyer) {
                    alertCount++;
                    lastAlertTime = nowTime;
                    currentTargetBuyer = qualifyingBuyer;
                    renderTargetReachedAlert(qualifyingBuyer, nowTime);
                    console.log('----------------------------------------------------------------------------------------');
                } else {
                    currentTargetBuyer = null;
                    const diff = (TARGET_PRICE_BOB - bestOverallPrice).toFixed(3);
                    const bestPlatName = bestOverall.platform ? bestOverall.platform.toUpperCase() : '';
                    console.log(` ⏳ Mejor precio actual en mercado: \x1b[36m\x1b[1m${bestOverallPrice.toFixed(3)} BOB\x1b[0m [${bestPlatName}] (Faltan ${diff} BOB para tu meta de ${TARGET_PRICE_BOB.toFixed(2)})`);
                    if (lastAlertTime) {
                        console.log(` ℹ️  Última vez que alcanzó la meta: ${lastAlertTime}`);
                    }
                    console.log('----------------------------------------------------------------------------------------');
                }

                // Mostrar listas de compradores
                if (PLATFORM === 'both') {
                    console.log(' 🟡 TOP COMPRADORES BINANCE:');
                    const binList = buyersData.binance || [];
                    if (binList.length === 0) {
                        console.log('   ⏳ En espera de respuesta de Binance API...');
                    } else {
                        binList.slice(0, 3).forEach((b, i) => {
                            const isTargetMet = b.price >= TARGET_PRICE_BOB;
                            const priceColor = isTargetMet ? '\x1b[32m\x1b[1m' : '\x1b[37m';
                            const targetTag = isTargetMet ? ' 🎯 ¡META!' : '';
                            console.log(`   [#${i + 1}] ${b.nickName.padEnd(16, ' ')} │ ${priceColor}${b.price.toFixed(3)} BOB\x1b[0m${targetTag} │ Límites: ${b.minBob.toFixed(0).padStart(6, ' ')} a ${b.maxBob.toFixed(0).padStart(8, ' ')} Bs │ Éxito: ${b.successRate}%`);
                        });
                    }

                    console.log('\n 🟣 TOP COMPRADORES BYBIT:');
                    (buyersData.bybit || []).slice(0, 3).forEach((b, i) => {
                        const isTargetMet = b.price >= TARGET_PRICE_BOB;
                        const priceColor = isTargetMet ? '\x1b[32m\x1b[1m' : '\x1b[37m';
                        const targetTag = isTargetMet ? ' 🎯 ¡META!' : '';
                        console.log(`   [#${i + 1}] ${b.nickName.padEnd(16, ' ')} │ ${priceColor}${b.price.toFixed(3)} BOB\x1b[0m${targetTag} │ Límites: ${b.minBob.toFixed(0).padStart(6, ' ')} a ${b.maxBob.toFixed(0).padStart(8, ' ')} Bs │ Éxito: ${b.successRate}`);
                    });
                } else {
                    console.log(` 📋 MEJORES COMPRADORES EN VIVO (${PLATFORM.toUpperCase()}):`);
                    allBuyers.slice(0, 5).forEach((b, i) => {
                        const isTargetMet = b.price >= TARGET_PRICE_BOB;
                        const priceColor = isTargetMet ? '\x1b[32m\x1b[1m' : '\x1b[37m';
                        const targetTag = isTargetMet ? ' 🎯 ¡META!' : '';
                        console.log(`   [#${i + 1}] ${b.nickName.padEnd(16, ' ')} │ ${priceColor}${b.price.toFixed(3)} BOB\x1b[0m${targetTag} │ Límites: ${b.minBob.toFixed(0).padStart(6, ' ')} a ${b.maxBob.toFixed(0).padStart(8, ' ')} Bs │ Éxito: ${b.successRate}%`);
                    });
                }

                console.log('========================================================================================');

            } catch (err) {
                // Silencioso ante fallos temporales
            }

            if (RUN_ONCE) {
                break;
            }
        }

        await new Promise(r => setTimeout(r, REFRESH_INTERVAL_MS));
    }
}

if (require.main === module) {
    startSellTargetLoop().catch(err => console.error('Error en Radar Vendedor:', err));
}

module.exports = {
    startSellTargetLoop,
    getTopBuyers
};
