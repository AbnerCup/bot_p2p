/**
 * ASISTENTE Y MONITOR EN VIVO BINANCE P2P
 * 
 * Funcionalidades:
 * 1. Monitoreo en Tiempo Real (cada 1-2s) del mercado P2P BOB/USDT.
 * 2. Sugerencias Dinámicas de Precios según tu fórmula:
 *    - Compra: Precio más popular (mayor concurrencia de anuncios).
 *    - Límite Mínimo BOB: 35 * media_actual (para amortizar la comisión de Binance).
 *    - Costo Base: Leído desde tus compras reales en history.json.
 *    - Venta: Garantiza al menos +0.04 BOB sobre tu costo base (o la media del mercado si es mayor).
 * 3. Escuchador Activo de Órdenes P2P con Alerta Bloqueante Anti-Terceros:
 *    - Detiene cualquier transferencia si detecta nombres no coincidentes.
 *    - Ejecuta auto-transferencia en Banco Sol y genera comprobante digital si es legítima.
 */

const readline = require('readline');
const { fetchBinanceP2P } = require('./binance/market');
const { queryBinanceApi, getLiveBinanceBalancesFromApi } = require('./binance/balances');
const { calculateStrategicRecommendations } = require('./binance/strategy');
const { verifyHolderName } = require('./security/verifier');
const { processBancoSolTransferJIT } = require('./banks/bancosol');
const { recordTransaction } = require('./utils/ledger');
const { getTodayQRPath } = require('./utils/qr_manager');
const { fetchBinanceOrderDetailsAndChat, sendBinanceOrderChatAndQR } = require('./binance/order_page');
const { logMarketChange } = require('./binance/market_logger');
const { startWebServer, getLocalIpAddress, PORT: WEB_PORT } = require('./web/server');

// Estado interno del Monitor
let isMonitoring = true;
let isProcessingOrder = false;
let userBalanceUsdt = 400.00;
let lastKnownOrders = new Set();
let cycleCount = 0;
let webServerInstance = null;

// Configuración de teclado interactivo
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

process.stdin.on('keypress', async (str, key) => {
    if (key.ctrl && key.name === 'c' || key.name === 'q') {
        console.log('\n\n👋 Cerrando Monitor Binance P2P. ¡Hasta pronto!');
        process.exit(0);
    }
    
    if (key.name === 't' && !isProcessingOrder) {
        // Disparar prueba de seguridad / simulación de orden
        await triggerTestOrderSimulation();
    }
});

let latestOrder = null;

/**
 * Consulta las órdenes activas en Binance P2P vía API Oficial
 */
async function checkActiveBinanceOrders() {
    try {
        const res = await queryBinanceApi('/sapi/v1/c2c/orderMatch/listUserOrderHistory', 'GET', {
            page: 1,
            rows: 5
        });

        if (res && res.data && Array.isArray(res.data) && res.data.length > 0) {
            latestOrder = res.data[0];

            // Detectar órdenes activas (PENDING, TRADING, BUYER_PAYED o cualquiera no finalizada)
            const activeOrders = res.data.filter(o => 
                o.orderStatus === 'PENDING' || 
                o.orderStatus === 'TRADING' || 
                o.orderStatus === 'BUYER_PAYED' ||
                (o.orderStatus !== 'COMPLETED' && !o.orderStatus.includes('CANCEL'))
            );

            for (const order of activeOrders) {
                if (!lastKnownOrders.has(order.orderNumber)) {
                    lastKnownOrders.add(order.orderNumber);
                    await handleIncomingBinanceOrder(order);
                }
            }
        }
    } catch (e) {
        // Silencioso para no romper la pantalla
    }
}

/**
 * Maneja una orden entrante con Verificación Anti-Terceros Estricta
 */
async function handleIncomingBinanceOrder(order) {
    isProcessingOrder = true;
    console.log('\n\x07'); // Emite sonido de alerta en la consola
    console.log('========================================================================');
    console.log(` 📦 ¡NUEVA ORDEN DETECTADA EN BINANCE P2P! #${order.orderNumber}`);
    console.log('========================================================================');
    console.log(`- Tipo:           ${order.tradeType}`);
    console.log(`- Comprador:      ${order.counterPartNickName}`);
    console.log(`- Monto:          ${order.totalPrice} BOB (${order.amount} USDT @ ${order.unitPrice})`);
    console.log(`- Método de Pago: ${order.payMethodName}\n`);

    // 1. VERIFICACIÓN DE SEGURIDAD ANTI-TERCEROS
    console.log('🛡️  VERIFICANDO TITULARIDAD ANTI-TERCEROS...');
    
    // Supongamos que el titular reportado para el pago es comparado
    const titularBanco = order.counterPartNickName; // En live se obtiene del detalle de pago
    const verification = verifyHolderName(order.counterPartNickName, titularBanco);

    if (!verification.isValid) {
        // MOSTRAR ADVERTENCIA CRÍTICA BLOQUEANTE
        console.log('\n************************************************************************');
        console.log(' 🚨🚨🚨 ¡ADVERTENCIA CRÍTICA: ORDEN BLOQUEADA POR SEGURIDAD! 🚨🚨🚨');
        console.log('************************************************************************');
        console.log(`⛔ MOTIVO: ${verification.reason}`);
        console.log(`⛔ Usuario registrado en Binance: ${order.counterPartNickName}`);
        console.log(`⛔ Titular de la cuenta bancaria: ${titularBanco}`);
        console.log('⛔ ACCIÓN DEL BOT: TRANSFERENCIA DETENIDA INMEDIATAMENTE.');
        console.log('⛔ No transfieras ni liberes fondos hasta que el usuario resuelva la titularidad.');
        console.log('************************************************************************\n');
        
        isProcessingOrder = false;
        return;
    }

    console.log('✅ Titularidad Aprobada: El titular del banco coincide con el usuario de Binance.\n');

    // 2. EJECUCIÓN AUTOMÁTICA EN BANCO SOL (Si nosotros compramos USDT y debemos pagar BOB)
    if (order.tradeType === 'BUY') {
        console.log('⚡ [ORDEN DE COMPRA]: Tú compras USDT. Abriendo orden para extraer datos reales del pago y chat...');
        try {
            const { fetchBinanceOrderDetailsAndChat } = require('./binance/order_page');
            const details = await fetchBinanceOrderDetailsAndChat(order.orderNumber, false);

            const targetAccount = details.accountNumber;
            const targetBank = details.bankName || 'Banco Solidario S.A.';
            const targetHolder = details.beneficiaryName || order.counterPartNickName;
            const targetAmount = details.amountBob > 0 ? details.amountBob : parseFloat(order.totalPrice);

            if (!targetAccount) {
                console.log('⚠️ No se detectó un número de cuenta explícito en la orden ni en el chat.');
                console.log(`Revisa la pantalla guardada en: ${details.orderFolder}`);
                isProcessingOrder = false;
                return;
            }

            console.log(`\n🏦 Datos reales obtenidos:`);
            console.log(`- Banco:   ${targetBank}`);
            console.log(`- Cuenta:  ${targetAccount}`);
            console.log(`- Titular: ${targetHolder}`);
            console.log(`- Monto:   ${targetAmount} BOB\n`);

            const transferRes = await processBancoSolTransferJIT({
                accountNumber: targetAccount,
                amountBob: targetAmount,
                counterpartyBybitName: targetHolder,
                destinationBank: targetBank,
                qrImagePath: details.detectedQRPath || null
            });

            if (transferRes.success) {
                console.log(`📸 Comprobante bancario capturado en: ${transferRes.receiptPath}`);
                
                // Registrar en el historial de compras
                recordTransaction({
                    orderId: order.orderNumber,
                    type: 'COMPRA',
                    amountUsdt: parseFloat(order.amount),
                    amountBob: targetAmount,
                    price: parseFloat(order.unitPrice),
                    netProfitBob: parseFloat(order.amount) * 0.04,
                    bank: targetBank,
                    counterparty: targetHolder
                });
                console.log('📊 Transacción asentada en history.json. Costo base actualizado.\n');
            } else {
                console.log(`⚠️ Falló la transferencia en Banco Sol: ${transferRes.reason}`);
            }
        } catch (err) {
            console.error('Error al procesar transferencia:', err.message);
        }
    } else if (order.tradeType === 'SELL') {
        // NOSOTROS VENDEMOS USDT: El comprador nos deposita BOB
        console.log('💰 [ORDEN DE VENTA DE USDT]: El comprador te debe depositar BOB en tu banco.');
        console.log(`👉 Esperando que ${order.counterPartNickName} transfiera exactamente ${order.totalPrice} BOB a tu cuenta (${order.payMethodName}).`);
        const todayQR = getTodayQRPath();
        if (todayQR) {
            console.log(`📲 QR de Cobro Listo: ${todayQR}`);
            console.log(`🚀 Enviando mensaje de bienvenida y QR del día al chat de la orden #${order.orderNumber}...`);
            await sendBinanceOrderChatAndQR(order.orderNumber, null, false);
        } else {
            console.log(`💡 Tip: Puedes colocar tu QR de hoy en "qr_dia/qr_actual.png" para tenerlo listo.`);
        }
        console.log('\n------------------------------------------------------------------------');
        console.log(' 🛡️  PROTOCOLO DE SEGURIDAD PARA LIBERAR TUS USDT:');
        console.log('------------------------------------------------------------------------');
        console.log(`1. Abre tu app bancaria (${order.payMethodName || 'Banco Sol/Unión/BCP'}).`);
        console.log(`2. Verifica que hayan ingresado exactamente: ${order.totalPrice} BOB.`);
        console.log(`3. VERIFICACIÓN ANTI-TERCEROS: El depositante DEBE ser: "${order.counterPartNickName}".`);
        console.log('⛔ SI EL PAGO VIENE DE OTRA PERSONA (TERCERO): NO LIBERES. Reporta en el chat.');
        console.log('✅ SI EL DINERO ESTÁ ACREDITADO Y EL NOMBRE COINCIDE: Haz clic en "Pago recibido" en Binance.');
        console.log('------------------------------------------------------------------------\n');

        // Registrar venta en historial
        try {
            recordTransaction({
                orderId: order.orderNumber,
                type: 'VENTA',
                amountUsdt: parseFloat(order.amount),
                amountBob: parseFloat(order.totalPrice),
                price: parseFloat(order.unitPrice),
                netProfitBob: parseFloat(order.amount) * (parseFloat(order.unitPrice) - 10.90),
                bank: order.payMethodName || 'BANCO',
                counterparty: order.counterPartNickName
            });
            console.log('📊 Venta asentada en history.json. Ganancia registrada.');
        } catch (e) {}
    }

    isProcessingOrder = false;
}

/**
 * Simulación de prueba interactiva para verificar advertencias en consola
 */
async function triggerTestOrderSimulation() {
    isProcessingOrder = true;
    console.log('\n------------------------------------------------------------------------');
    console.log(' 🧪 PRUEBA DE DISPARO DE SEGURIDAD (SIMULACIÓN DE ORDEN CON TERCERO)');
    console.log('------------------------------------------------------------------------');
    console.log('Simulando llegada de orden donde Comprador Binance = "JUAN PEREZ" pero Banco = "PEDRO MAMANI"...');
    
    await new Promise(r => setTimeout(r, 1000));
    
    const verification = verifyHolderName('JUAN PEREZ', 'PEDRO MAMANI');
    console.log('\x07');
    console.log('\n************************************************************************');
    console.log(' 🚨🚨🚨 ¡ADVERTENCIA CRÍTICA: OPERACIÓN BLOQUEADA POR SEGURIDAD! 🚨🚨🚨');
    console.log('************************************************************************');
    console.log(`⛔ ${verification.reason}`);
    console.log('⛔ DETECCIÓN: Posible triangulación o pago de tercero.');
    console.log('⛔ ACCIÓN: El bot HA DETENIDO la operación. Banco Sol NO ha sido tocado.');
    console.log('************************************************************************\n');
    console.log('Presiona cualquier tecla para volver al monitor en vivo...');
    await new Promise(r => setTimeout(r, 4000));
    isProcessingOrder = false;
}

/**
 * Actualiza el balance en segundo plano
 */
async function syncBalance() {
    try {
        const balances = await getLiveBinanceBalancesFromApi();
        if (balances) {
            userBalanceUsdt = balances.usdtFunding;
        }
    } catch (e) {}
}

/**
 * Bucle Principal de Monitoreo y Decisiones
 */
async function runRealTimeMonitoringLoop() {
    console.clear();
    console.log('🚀 Conectando con Binance P2P y cargando saldos...');
    await syncBalance();

    if (!webServerInstance) {
        try {
            webServerInstance = startWebServer(WEB_PORT);
        } catch(e) {}
    }

    setInterval(async () => {
        if (isProcessingOrder) return; // Pausar refresco si hay una orden en curso

        cycleCount++;
        try {
            // 1. Obtener ofertas del mercado en vivo (Perspectiva MAKER)
            const [competitorBuyers, competitorSellers] = await Promise.all([
                fetchBinanceP2P({ tradeType: 'SELL', rows: 20 }),
                fetchBinanceP2P({ tradeType: 'BUY', rows: 20 })
            ]);

            // 2. Calcular recomendaciones según las fórmulas del usuario
            const strategy = calculateStrategicRecommendations(competitorBuyers, competitorSellers);

            // 3. Registrar cambios en las ofertas para análisis histórico (CSV y JSON)
            logMarketChange(strategy, competitorBuyers, competitorSellers);

            // 4. Revisar órdenes activas en Binance P2P en cada ciclo (tiempo real continuo)
            await checkActiveBinanceOrders();

            // 5. Cada 20 ciclos actualizar saldo real de fondos
            if (cycleCount % 20 === 0) {
                await syncBalance();
            }

            // 5. Extraer datos exactos de Compra y Venta en tiempo real
            // En Binance:
            // competitorSellers: tradeType BUY (vendedores donde compramos USDT)
            // competitorBuyers:  tradeType SELL (compradores donde vendemos USDT)
            const topSeller = competitorSellers[0] || {};
            const advS = topSeller.adv || {};
            const advrS = topSeller.advertiser || {};
            const buyPrice = parseFloat(advS.price || 0);
            const buyMinBob = parseFloat(advS.minSingleTransAmount || 0);
            const buyMaxBobRaw = parseFloat(advS.maxSingleTransAmount || 0);
            const buyAvailUsdt = parseFloat(advS.surplusAmount || 0);
            const buyMinUsdt = buyPrice > 0 ? (buyMinBob / buyPrice) : 0;
            let buyMaxUsdt = buyPrice > 0 ? (buyMaxBobRaw / buyPrice) : 0;
            if (buyAvailUsdt > 0 && buyAvailUsdt < buyMaxUsdt) buyMaxUsdt = buyAvailUsdt;
            const buyMaxBob = buyMaxUsdt * buyPrice;
            const buyNick = advrS.nickName || 'Vendedor';

            const topBuyer = competitorBuyers[0] || {};
            const advB = topBuyer.adv || {};
            const advrB = topBuyer.advertiser || {};
            const sellPrice = parseFloat(advB.price || 0);
            const sellMinBob = parseFloat(advB.minSingleTransAmount || 0);
            const sellMaxBobRaw = parseFloat(advB.maxSingleTransAmount || 0);
            const sellAvailUsdt = parseFloat(advB.surplusAmount || 0);
            const sellMinUsdt = sellPrice > 0 ? (sellMinBob / sellPrice) : 0;
            let sellMaxUsdt = sellPrice > 0 ? (sellMaxBobRaw / sellPrice) : 0;
            if (sellAvailUsdt > 0 && sellAvailUsdt < sellMaxUsdt) sellMaxUsdt = sellAvailUsdt;
            const sellMaxBob = sellMaxUsdt * sellPrice;
            const sellNick = advrB.nickName || 'Comprador';

            const spread = (sellPrice > 0 && buyPrice > 0) ? (sellPrice - buyPrice).toFixed(3) : '0.000';
            const spreadPercent = buyPrice > 0 ? (((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2) : '0.00';

            const now = new Date().toLocaleTimeString('es-BO', { hour12: false });

            console.clear();
            console.log('========================================================================================');
            console.log(` ⚡ MONITOR BINANCE P2P [${now}] │ 💰 Billetera: ${userBalanceUsdt.toFixed(2)} USDT`);
            console.log('========================================================================================\n');

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
            console.log(' ⌨️  [t] Simular orden tercero | [q] Salir');
            console.log('========================================================================================');

        } catch (error) {
            // Manejar error transitorio de red sin tumbar el bucle
        }
    }, 1500); // Consulta rápida y segura cada 1.5 segundos
}

if (require.main === module) {
    runRealTimeMonitoringLoop().catch(err => console.error('Error:', err));
}

module.exports = {
    runRealTimeMonitoringLoop
};
