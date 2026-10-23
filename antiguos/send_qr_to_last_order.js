/**
 * Script para enviar el QR del día al chat de la última orden (o la orden especificada)
 */

const { sendBinanceOrderChatAndQR } = require('./binance/order_page');
const { queryBinanceApi } = require('./binance/balances');
const history = require('./history.json');

async function main() {
    let orderNumber = process.argv[2];

    if (!orderNumber) {
        console.log('🔍 Buscando última orden activa o reciente en Binance...');
        try {
            const res = await queryBinanceApi('/sapi/v1/c2c/orderMatch/listUserOrderHistory', 'GET', {
                page: 1,
                rows: 5
            });

            if (res && res.data && Array.isArray(res.data) && res.data.length > 0) {
                const latest = res.data[0];
                orderNumber = latest.orderNumber;
                console.log(`📌 Última orden encontrada en Binance API: #${orderNumber} (${latest.tradeType} - ${latest.totalPrice} BOB)`);
            }
        } catch (e) {
            console.log('ℹ️ No se pudo conectar a Binance API para buscar automáticamente. Usando historial local...');
        }

        // Fallback al historial local history.json
        if (!orderNumber && Array.isArray(history) && history.length > 0) {
            const lastEntry = history[history.length - 1];
            orderNumber = lastEntry.id;
            console.log(`📌 Última orden encontrada en history.json: #${orderNumber}`);
        }
    }

    if (!orderNumber) {
        console.error('❌ No se especificó ni se encontró ningún número de orden.');
        console.log('Uso: node send_qr_to_last_order.js <NUMERO_DE_ORDEN>');
        return;
    }

    console.log(`\n=============================================================`);
    console.log(` 📤 ENVIANDO QR DEL DÍA A LA ORDEN #${orderNumber}`);
    console.log(`=============================================================\n`);

    const result = await sendBinanceOrderChatAndQR(orderNumber, null, false);

    if (result.success) {
        console.log('\n✅ ¡QR enviado exitosamente al chat de la orden!');
    } else {
        console.log(`\n⚠️ No se pudo enviar el QR: ${result.reason}`);
    }
}

main();
