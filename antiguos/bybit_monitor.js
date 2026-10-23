/**
 * ASISTENTE Y MONITOR EN VIVO BYBIT P2P
 * 
 * Funcionalidades:
 * 1. Monitoreo en Tiempo Real (cada 1.5 - 2s) del mercado P2P BOB/USDT en Bybit.
 * 2. Sugerencias Dinámicas de Precios:
 *    - Compra: Precio más popular / competitivo para comprar barato.
 *    - Límite Mínimo BOB: 50.00 BOB y capacidad según saldo en Banco Sol.
 *    - Costo Base: Leído desde tus compras reales en history.json.
 *    - Venta: Garantiza al menos +0.04 BOB sobre tu costo base (o la media alta del mercado).
 *    - Margen Neto Proyectado (+0.04 BOB o más).
 * 3. Controles Interactivos con el Teclado:
 *    - [c]: Publica / Actualiza tu anuncio de COMPRA en Bybit P2P con el precio sugerido.
 *    - [v]: Publica / Actualiza tu anuncio de VENTA en Bybit P2P con el precio sugerido.
 *    - [q]: Salir del monitor.
 * 4. Vigilante Silencioso de Órdenes P2P con Verificación Anti-Terceros y Banco Sol.
 */

const readline = require('readline');
const { fetchBybitP2P } = require('./bybit/market');
const { filterEligibleAds, filterIgnoredMerchants, loadIgnoredMerchants, addIgnoredMerchant, removeIgnoredMerchant } = require('./bybit/eligibility');
const { getLiveBybitBalancesFromApi, getLiveBybitUsdtBalance } = require('./bybit/balances');
const { calculateBybitStrategicRecommendations } = require('./bybit/strategy');
const { publishBybitMakerAd } = require('./bybit/ads');
const { getBancoSolLiveBalance } = require('./banks/bancosol');
const { verifyHolderName } = require('./security/verifier');
const { processBancoSolTransferJIT } = require('./banks/bancosol');
const { recordTransaction } = require('./utils/ledger');
const { generateBybitFinancialReport, printReportScreen, exportReportToCSV } = require('./bybit/report');

// Estado interno del Monitor
let isMonitoring = true;
let isPublishingAd = false;
let isShowingReport = false;
let isPromptingBlock = false;
let latestReportData = null;
let userBalanceUsdt = 0.00;
let userBalanceBob = 54.00;
let cycleCount = 0;
let latestStrategy = null;
let lastRawSellers = [];
let lastRawBuyers = [];

const monitorArgs = process.argv.slice(2);
let REFRESH_INTERVAL_MS = 1800; // Por defecto cada 1.8 segundos
const intervalIdx = monitorArgs.findIndex(a => a === '--interval' || a === '-i');
if (intervalIdx !== -1 && monitorArgs[intervalIdx + 1] && !isNaN(parseInt(monitorArgs[intervalIdx + 1]))) {
    REFRESH_INTERVAL_MS = parseInt(monitorArgs[intervalIdx + 1], 10);
} else if (monitorArgs.includes('--fast')) {
    REFRESH_INTERVAL_MS = 1000;
} else if (monitorArgs.includes('--slow')) {
    REFRESH_INTERVAL_MS = 3000;
} else {
    const directMs = monitorArgs.find(a => /^\d{3,4}$/.test(a));
    if (directMs) REFRESH_INTERVAL_MS = parseInt(directMs, 10);
}

let FILTER_ELIGIBLE = monitorArgs.some(a => a === '--elegible' || a === '--eligible' || a === '-e') ||
                      monitorArgs.includes('--elegible=on') ||
                      (monitorArgs.indexOf('--elegible') !== -1 && monitorArgs[monitorArgs.indexOf('--elegible') + 1] === 'on');

// Configuración de teclado interactivo
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

process.stdin.on('keypress', async (str, key) => {
    if (isPromptingBlock) return; // Si estamos en el diálogo de bloqueo, ignorar teclas normales

    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        console.log('\n\n👋 Cerrando Monitor Bybit P2P. ¡Hasta pronto!');
        process.exit(0);
    }

    // Si estamos en la vista de informe / ganancias
    if (isShowingReport) {
        if (key.name === 'e') {
            if (latestReportData) {
                const csvPath = exportReportToCSV(latestReportData, 'reporte_bybit.csv');
                console.log(`\n📁 ¡Reporte exportado exitosamente a Excel en: ${csvPath}`);
                console.log('Presiona [g] o [Enter] para regresar al monitor...');
            }
            return;
        }

        if (key.name === 'g' || key.name === 'i' || key.name === 'return' || key.name === 'space' || key.name === 'escape') {
            isShowingReport = false;
            console.clear();
            console.log('🔄 Reanudando Asistente y Monitor Bybit P2P en tiempo real...');
            return;
        }

        return;
    }

    // Tecla [b]: Bloquear comerciante / Gestionar lista negra
    if (key.name === 'b' && !isPublishingAd) {
        await triggerBlockMerchantPrompt();
        return;
    }

    // Tecla [e]: Alternar filtro de elegibles
    if (key.name === 'e' && !isPublishingAd) {
        FILTER_ELIGIBLE = !FILTER_ELIGIBLE;
        console.log(`\n🛡️ [FILTRO ELEGIBILIDAD]: ${FILTER_ELIGIBLE ? 'ACTIVADO (solo tus anuncios elegibles)' : 'DESACTIVADO (mercado tradicional completo)'}`);
        return;
    }

    // Tecla [g] o [i]: Sacar ganancias, compras, ventas y saldo de Banco Sol
    if ((key.name === 'g' || key.name === 'i') && !isPublishingAd) {
        await triggerShowFinancialReport();
        return;
    }

    if (key.name === 'c' && !isPublishingAd) {
        // Disparar publicación de anuncio de COMPRA
        await triggerAdPublish('BUY');
    }

    if (key.name === 'v' && !isPublishingAd) {
        // Disparar publicación de anuncio de VENTA
        await triggerAdPublish('SELL');
    }
});

/**
 * Muestra en pantalla el informe de ganancias, compras, ventas y saldo en Banco Sol
 */
async function triggerShowFinancialReport() {
    isShowingReport = true;
    console.clear();
    console.log('================================================================================');
    console.log(' ⏳ CALCULANDO GANANCIAS Y AUDITORÍA FINANCIERA (BYBIT + BANCO SOL)...');
    console.log('================================================================================');

    try {
        latestReportData = await generateBybitFinancialReport({ liveSaldos: true });
        console.clear();
        printReportScreen(latestReportData);

        console.log('================================================================================');
        console.log(' ⌨️  [g] o [Enter]: Volver al Monitor | [e]: Exportar a Excel (CSV) | [q]: Salir');
        console.log('================================================================================');
    } catch (e) {
        console.error('❌ Error al generar el informe de ganancias:', e.message);
        console.log('\nPresiona [Enter] para volver al monitor...');
    }
}

/**
 * Despliega el menú interactivo para bloquear o desbloquear anunciantes en Bybit P2P
 */
async function triggerBlockMerchantPrompt() {
    isPromptingBlock = true;
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }

    console.clear();
    const currentIgnored = loadIgnoredMerchants();
    console.log('========================================================================================');
    console.log(' 🚫 GESTIÓN DE ANUNCIANTES BLOQUEADOS / LISTA NEGRA (BYBIT P2P)');
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

    // Candidatos sugeridos de los últimos anuncios vistos en el monitor
    const candidates = [];
    (lastRawSellers || []).slice(0, 4).forEach(s => {
        const n = (s.nickName || '').trim();
        if (n && !candidates.map(c => c.name.toUpperCase()).includes(n.toUpperCase())) {
            candidates.push({ name: n, type: 'Vendedor', price: s.price });
        }
    });
    (lastRawBuyers || []).slice(0, 4).forEach(b => {
        const n = (b.nickName || '').trim();
        if (n && !candidates.map(c => c.name.toUpperCase()).includes(n.toUpperCase())) {
            candidates.push({ name: n, type: 'Comprador', price: b.price });
        }
    });

    if (candidates.length > 0) {
        console.log('💡 Anunciantes detectados recientemente en pantalla (escribe su número para bloquear):');
        candidates.forEach((cand, idx) => {
            const isAlreadyBlocked = currentIgnored.includes(cand.name.toUpperCase());
            const tag = isAlreadyBlocked ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
            console.log(`   [#${idx + 1}] ${cand.type.padEnd(9)}: ${cand.name} (${cand.price} BOB)${tag}`);
        });
        console.log('----------------------------------------------------------------------------------------');
    }

    console.log('👉 Instrucciones:');
    console.log('   • Escribe el número [#1, #2...] para bloquear al anunciante sugerido.');
    console.log('   • O escribe el NOMBRE del anunciante que deseas bloquear (ej: CarlosP2P).');
    console.log('   • Puedes escribir varios separados por comas (ej: Usuario1, Usuario2).');
    console.log('   • Para DESBLOQUEAR a alguien de la lista, antepón un guion: -NOMBRE (ej: -NOVATRAD).');
    console.log('   • Presiona [ENTER] vacío para volver al monitor sin hacer cambios.\n');

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
            console.log('\n🔙 Volviendo al monitor...');
            return;
        }

        const num = parseInt(input, 10);
        if (!isNaN(num) && num >= 1 && num <= candidates.length) {
            const target = candidates[num - 1].name;
            addIgnoredMerchant(target);
            console.log(`\n🚫 ¡Comerciante "${target}" AGREGADO a la lista de bloqueados!`);
            console.log('   Se ha guardado en ignored_merchants.json y ya no se mostrará en el monitor.');
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
            console.log('   Se ha guardado en ignored_merchants.json y ya no se mostrará en el monitor.');
        }

        setTimeout(() => {}, 1500);
    });
}

/**
 * Publica un anuncio en Bybit P2P usando los precios calculados
 */
async function triggerAdPublish(side) {
    if (!latestStrategy) {
        console.log('\n⚠️ Esperando datos de mercado para calcular precio...');
        return;
    }

    isPublishingAd = true;
    console.log(`\n\n🚀 [ACCIÓN MANUAL]: Iniciando publicación de anuncio de ${side} en Bybit P2P...`);

    const targetPrice = side === 'BUY' ? latestStrategy.suggestedBuyPrice : latestStrategy.suggestedSellPrice;
    
    // Si es COMPRA: volumen calculado según saldo en Banco Sol
    // Si es VENTA: volumen según saldo en USDT de Bybit
    let targetAmountUsdt = 10.00;
    if (side === 'BUY') {
        const capacityUsdt = userBalanceBob > 0 ? (userBalanceBob / parseFloat(targetPrice)) : 10;
        targetAmountUsdt = parseFloat(capacityUsdt.toFixed(2));
    } else {
        targetAmountUsdt = userBalanceUsdt > 0 ? parseFloat(userBalanceUsdt.toFixed(2)) : 10.00;
    }

    await publishBybitMakerAd({
        side: side,
        price: targetPrice,
        amountUsdt: targetAmountUsdt,
        minLimitBob: 50,
        maxLimitBob: userBalanceBob > 50 ? userBalanceBob : 10000,
        headless: false // Visible para que el usuario aprecie el auto-llenado
    });

    isPublishingAd = false;
    console.log('\n✅ Proceso de publicación finalizado. Reanudando monitor en 3 segundos...');
    await new Promise(r => setTimeout(r, 3000));
}

/**
 * Actualiza los balances en segundo plano
 */
async function syncBalances() {
    try {
        const balances = await getLiveBybitBalancesFromApi();
        if (balances) {
            userBalanceUsdt = balances.usdtFunding > 0 ? balances.usdtFunding : balances.totalUsdt;
        }
        userBalanceBob = await getBancoSolLiveBalance();
    } catch (e) {}
}

/**
 * Bucle Principal de Monitoreo en Tiempo Real
 */
async function runRealTimeBybitMonitoringLoop() {
    console.clear();
    console.log('🚀 Conectando con Bybit P2P y cargando saldos...');
    await syncBalances();

    // Bucle continuo cada 1.8 segundos
    const interval = setInterval(async () => {
        if (isPublishingAd || isShowingReport || isPromptingBlock) return; // Pausar si se está publicando, viendo reporte o bloqueando

        cycleCount++;
        try {
            // 1. Obtener ofertas del mercado en tiempo real sin navegadores (API REST JSON rápida)
            const [rawBuyers, rawSellers] = await Promise.all([
                fetchBybitP2P({ side: '0', size: 20 }), // Compradores (Donde vendemos USDT)
                fetchBybitP2P({ side: '1', size: 20 })  // Vendedores (Donde compramos USDT)
            ]);

            lastRawBuyers = rawBuyers || [];
            lastRawSellers = rawSellers || [];

            // Filtrar anunciantes bloqueados SIEMPRE, y si FILTER_ELIGIBLE está ON, filtrar también por requisitos de cuenta
            const competitorBuyers = FILTER_ELIGIBLE ? filterEligibleAds(rawBuyers) : filterIgnoredMerchants(rawBuyers);
            const competitorSellers = FILTER_ELIGIBLE ? filterEligibleAds(rawSellers) : filterIgnoredMerchants(rawSellers);

            // 2. Calcular recomendaciones estratégicas (Margen +0.04 BOB)
            const strategy = calculateBybitStrategicRecommendations(competitorBuyers, competitorSellers);
            latestStrategy = strategy;

            // 3. Cada 15 ciclos actualizar saldos reales
            if (cycleCount % 15 === 0) {
                await syncBalances();
            }

            // 4. Extraer datos exactos de Compra y Venta en tiempo real
            const topSeller = competitorSellers[0] || {};
            const buyPrice = parseFloat(topSeller.price || 0);
            const buyMinBob = parseFloat(topSeller.minAmount || 0);
            const buyMaxBobRaw = parseFloat(topSeller.maxAmount || 0);
            const buyAvailUsdt = parseFloat(topSeller.lastQuantity || 0);
            const buyMinUsdt = buyPrice > 0 ? (buyMinBob / buyPrice) : 0;
            let buyMaxUsdt = buyPrice > 0 ? (buyMaxBobRaw / buyPrice) : 0;
            if (buyAvailUsdt > 0 && buyAvailUsdt < buyMaxUsdt) buyMaxUsdt = buyAvailUsdt;
            const buyMaxBob = buyMaxUsdt * buyPrice;
            const buyNick = topSeller.nickName || 'Vendedor';

            const topBuyer = competitorBuyers[0] || {};
            const sellPrice = parseFloat(topBuyer.price || 0);
            const sellMinBob = parseFloat(topBuyer.minAmount || 0);
            const sellMaxBobRaw = parseFloat(topBuyer.maxAmount || 0);
            const sellAvailUsdt = parseFloat(topBuyer.lastQuantity || 0);
            const sellMinUsdt = sellPrice > 0 ? (sellMinBob / sellPrice) : 0;
            let sellMaxUsdt = sellPrice > 0 ? (sellMaxBobRaw / sellPrice) : 0;
            if (sellAvailUsdt > 0 && sellAvailUsdt < sellMaxUsdt) sellMaxUsdt = sellAvailUsdt;
            const sellMaxBob = sellMaxUsdt * sellPrice;
            const sellNick = topBuyer.nickName || 'Comprador';

            const spread = (sellPrice > 0 && buyPrice > 0) ? (sellPrice - buyPrice).toFixed(3) : '0.000';
            const spreadPercent = buyPrice > 0 ? (((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2) : '0.00';

            const now = new Date().toLocaleTimeString('es-BO', { hour12: false });
            const ignoredList = loadIgnoredMerchants();
            const blockedCount = ignoredList.length;

            const rawTopSeller = (rawSellers || [])[0];
            const rawTopBuyer = (rawBuyers || [])[0];
            const isTopSellerBlocked = rawTopSeller && ignoredList.includes((rawTopSeller.nickName || '').toUpperCase());
            const isTopBuyerBlocked = rawTopBuyer && ignoredList.includes((rawTopBuyer.nickName || '').toUpperCase());

            console.clear();
            const totalReqs = cycleCount * 2;
            const reqPerSec = (2 / (REFRESH_INTERVAL_MS / 1000)).toFixed(1);
            console.log('========================================================================================');
            console.log(` ⚡ MONITOR BYBIT P2P [${now}] │ 📡 Peticiones: #${totalReqs} (~${reqPerSec} req/s) │ ⏱️ Intervalo: ${REFRESH_INTERVAL_MS}ms`);
            console.log(` 💰 Bybit: ${userBalanceUsdt.toFixed(2)} USDT │ 🏦 Banco Sol: ${userBalanceBob.toFixed(2)} BOB │ 🚫 Bloqueados: ${blockedCount} │ 🛡️ Elegibles: ${FILTER_ELIGIBLE ? 'ON' : 'OFF'}`);
            console.log('========================================================================================\n');

            if (isTopSellerBlocked) {
                console.log(` 🚫 \x1b[33m\x1b[1m[OMITIDO]: Vendedor "${rawTopSeller.nickName} (bloq)" a ${parseFloat(rawTopSeller.price).toFixed(3)} BOB está en tu lista negra. Se salta automáticamente.\x1b[0m`);
            }
            if (isTopBuyerBlocked) {
                console.log(` 🚫 \x1b[33m\x1b[1m[OMITIDO]: Comprador "${rawTopBuyer.nickName} (bloq)" a ${parseFloat(rawTopBuyer.price).toFixed(3)} BOB está en tu lista negra. Se salta automáticamente.\x1b[0m`);
            }
            if (isTopSellerBlocked || isTopBuyerBlocked) {
                console.log('----------------------------------------------------------------------------------------');
            }

            console.log(` 🟢 \x1b[1m\x1b[32mCOMPRA A "${buyNick}"\x1b[0m a \x1b[32m\x1b[1m${buyPrice.toFixed(2)} BOB\x1b[0m:`);
            console.log(`    👉 Debes comprar: \x1b[36m\x1b[1m${buyMinUsdt.toFixed(2)} $ a ${buyMaxUsdt.toFixed(2)} $ USDT\x1b[0m  │  En Bs: \x1b[33m\x1b[1m${buyMinBob.toFixed(0)} Bs a ${buyMaxBob.toFixed(0)} Bs\x1b[0m\n`);

            console.log(` 🔴 \x1b[1m\x1b[31mVENDE A "${sellNick}"\x1b[0m a \x1b[31m\x1b[1m${sellPrice.toFixed(2)} BOB\x1b[0m:`);
            console.log(`    👉 Debes vender:  \x1b[36m\x1b[1m${sellMinUsdt.toFixed(2)} $ a ${sellMaxUsdt.toFixed(2)} $ USDT\x1b[0m  │  En Bs: \x1b[33m\x1b[1m${sellMinBob.toFixed(0)} Bs a ${sellMaxBob.toFixed(0)} Bs\x1b[0m\n`);

            if (parseFloat(spread) > 0) {
                console.log(` 💰 SPREAD EN VIVO: \x1b[32m\x1b[1m+${spread} BOB/USDT (+${spreadPercent}%)\x1b[0m  🔥 (¡Brecha positiva en mercado!)`);
            } else {
                console.log(` ⚖️  DIFERENCIAL:    \x1b[37m${spread} BOB/USDT (${spreadPercent}%)\x1b[0m`);
            }

            console.log('----------------------------------------------------------------------------------------');
            console.log(' 📋 MERCADO EN VIVO (Top Anuncios):');
            console.log('   🟢 Vendedores (Para comprar USDT):');
            (rawSellers || []).slice(0, 3).forEach((s, idx) => {
                const isBloq = ignoredList.includes((s.nickName || '').toUpperCase());
                const bloqTag = isBloq ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
                const priceCol = isBloq ? '\x1b[90m' : '\x1b[32m\x1b[1m';
                console.log(`      [#${idx + 1}] ${s.nickName}${bloqTag} │ ${priceCol}${parseFloat(s.price).toFixed(3)} BOB\x1b[0m │ Lím: ${parseFloat(s.minAmount).toFixed(0)}-${parseFloat(s.maxAmount).toFixed(0)} Bs`);
            });

            console.log('   🔴 Compradores (Para vender USDT):');
            (rawBuyers || []).slice(0, 3).forEach((b, idx) => {
                const isBloq = ignoredList.includes((b.nickName || '').toUpperCase());
                const bloqTag = isBloq ? ' \x1b[31m\x1b[1m(bloq)\x1b[0m' : '';
                const priceCol = isBloq ? '\x1b[90m' : '\x1b[31m\x1b[1m';
                console.log(`      [#${idx + 1}] ${b.nickName}${bloqTag} │ ${priceCol}${parseFloat(b.price).toFixed(3)} BOB\x1b[0m │ Lím: ${parseFloat(b.minAmount).toFixed(0)}-${parseFloat(b.maxAmount).toFixed(0)} Bs`);
            });

            console.log('----------------------------------------------------------------------------------------');
            console.log(` ⌨️  [b] Bloquear Usuario | [e] Elegibles: ${FILTER_ELIGIBLE ? 'ON' : 'OFF'} | [c] Publicar Compra | [v] Publicar Venta | [g] Ganancias | [q] Salir`);
            console.log('========================================================================================');

        } catch (error) {
            // Silencioso para evitar parpadeos si hay un glitch de red momentáneo
        }
    }, REFRESH_INTERVAL_MS);
}

if (require.main === module) {
    runRealTimeBybitMonitoringLoop().catch(err => console.error('Error:', err));
}

module.exports = {
    runRealTimeBybitMonitoringLoop
};
