/**
 * Bot P2P Bybit - Orquestador Principal
 */
const { verifyHolderName } = require('./security/verifier');
const { processUnionTransfer } = require('./banks/banco_union');
const { processBcpTransfer } = require('./banks/bcp');
const { processBancoSolTransfer } = require('./banks/bancosol');
const { getActiveOrders, processP2POrder } = require('./bybit/orders');
const { runLiveRealBybitBotTest } = require('./index_bybit');

async function runBotCycle() {
    console.log('====================================================');
    console.log('   🤖 INICIANDO CICLO DE AUTOMATIZACIÓN BOT P2P BYBIT ');
    console.log('====================================================\n');

    // 1. Ejecutar lectura de mercado y saldos Bybit
    await runLiveRealBybitBotTest();

    // 2. Obtener órdenes activas de Bybit
    const orders = await getActiveOrders();

    if (!orders || orders.length === 0) {
        console.log('ℹ️ No hay órdenes pendientes por pagar en este momento.');
        return;
    }

    console.log(`📋 Procesando ${orders.length} orden(es) encontrada(s)...`);

    for (const order of orders) {
        const orderId = order.orderId || order.id || 'N/A';
        const amountBob = parseFloat(order.amount || order.totalPrice || 0);
        const amountUsdt = parseFloat(order.quantity || order.tokenQuantity || 0);
        const priceBob = parseFloat(order.price || 0);
        const sellerName = order.sellerName || order.userNickName || 'Desconocido';
        const bankName = order.bankName || 'Banco Solidario S.A.';
        const accountNumber = order.accountNumber || '100000012345';

        const result = await processP2POrder({
            orderId,
            orderType: 'BUY',
            counterpartyName: sellerName,
            bankName,
            accountNumber,
            amountBob,
            amountUsdt,
            priceBob
        });

        if (result.success) {
            console.log(`🎉 Orden #${orderId} pagada con éxito.`);
        } else {
            console.log(`⚠️ La orden #${orderId} fue pausada por seguridad: ${result.reason}`);
        }
    }
}

if (require.main === module) {
    runBotCycle().catch(err => console.error('Error en el ciclo del bot Bybit:', err));
}

module.exports = { runBotCycle };
