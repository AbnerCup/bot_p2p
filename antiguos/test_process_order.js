/**
 * Script de Procesamiento y Extracción Real de Orden Binance P2P
 * Extrae los datos reales del chat y del pago, verifica titularidad y ejecuta la transferencia.
 */

const { fetchBinanceOrderDetailsAndChat } = require('./binance/order_page');
const { verifyHolderName } = require('./security/verifier');
const { processBancoSolTransferJIT } = require('./banks/bancosol');
const { recordTransaction } = require('./utils/ledger');

async function processOrderLive(orderNumber) {
    if (!orderNumber) {
        console.log('Uso: node test_process_order.js <NUMERO_DE_ORDEN>');
        return;
    }

    console.log('=============================================================');
    console.log(` 🚀 PROCESANDO ORDEN REAL #${orderNumber} DESDE BINANCE`);
    console.log('=============================================================\n');

    // 1. Extraer datos reales de la pantalla y del chat
    const details = await fetchBinanceOrderDetailsAndChat(orderNumber, false);

    if (!details.success) {
        console.error('❌ No se pudieron extraer los datos de la orden:', details.error);
        return;
    }

    console.log('📋 Datos extraídos:');
    console.log(`- Titular: ${details.beneficiaryName}`);
    console.log(`- Banco:   ${details.bankName}`);
    console.log(`- Cuenta:  ${details.accountNumber}`);
    console.log(`- Monto:   ${details.amountBob} BOB\n`);

    if (!details.accountNumber || details.amountBob <= 0) {
        console.log('⚠️ Faltan datos críticos para realizar la transferencia automática.');
        console.log('Revisa la captura guardada en:', details.orderFolder);
        return;
    }

    // 2. Verificación Anti-Terceros
    const verification = verifyHolderName(details.beneficiaryName, details.beneficiaryName);
    if (!verification.isValid) {
        console.log('\n************************************************************************');
        console.log(' 🚨 ALERTA CRÍTICA: TITULAR NO COINCIDE. TRANSFERENCIA ABORTADA.');
        console.log('************************************************************************\n');
        return;
    }

    // 3. Ejecución en Banco Sol
    console.log('⚡ Iniciando transferencia en Banco Sol con los datos reales...');
    const transferRes = await processBancoSolTransferJIT({
        destinationBank: details.bankName,
        accountNumber: details.accountNumber,
        amountBob: details.amountBob,
        counterpartyBybitName: details.beneficiaryName,
        qrImagePath: details.detectedQRPath || null
    });

    if (transferRes.success) {
        console.log(`\n✅ Transferencia completada. Comprobante guardado en: ${transferRes.receiptPath}`);
        
        recordTransaction({
            orderId: orderNumber,
            type: 'COMPRA',
            amountUsdt: details.amountBob / 11.27,
            amountBob: details.amountBob,
            price: 11.27,
            netProfitBob: details.amountBob * 0.04,
            bank: details.bankName,
            counterparty: details.beneficiaryName
        });
    } else {
        console.log(`⚠️ Error en Banco Sol: ${transferRes.reason}`);
    }
}

const targetOrder = process.argv[2] || '22934000080524922880';
processOrderLive(targetOrder);
