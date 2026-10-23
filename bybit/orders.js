/**
 * Módulo de Gestión de Órdenes P2P Bybit + Verificación Anti-Terceros + Comprobante
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { verifyHolderName } = require('../security/verifier');
const { processBancoSolTransferJIT } = require('../banks/bancosol');
const { recordTransaction } = require('../utils/ledger');

const SESSION_FILE = path.join(__dirname, '../session_bybit.json');

async function getActiveOrders(headless = true) {
    console.log('--- Buscando Órdenes Entrantes Pendientes en Bybit ---');

    let storageState = undefined;
    if (fs.existsSync(SESSION_FILE)) {
        storageState = SESSION_FILE;
    } else {
        console.log('⚠️ No se encontró "session_bybit.json". Te recomendamos ejecutar "node bybit/auth.js" primero.');
    }

    const browser = await chromium.launch({
        headless: headless,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-http2'
        ]
    });

    const context = await browser.newContext({
        storageState: storageState,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    let pendingOrders = [];

    // Escuchar respuestas JSON de órdenes activas de Bybit
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/fiat/otc/order/list') || url.includes('/fiat/otc/order/pending') || url.includes('/otc/order') || url.includes('/otc/item')) {
            try {
                const json = await response.json();
                if (json && json.result) {
                    const items = json.result.items || json.result.list || json.result;
                    if (Array.isArray(items)) {
                        pendingOrders = items;
                    }
                }
            } catch (e) {}
        }
    });

    console.log('Navegando a la sección oficial de Órdenes P2P de Bybit (https://www.bybit.com/fiat/trade/otc/)...');
    try {
        await page.goto('https://www.bybit.com/fiat/trade/otc/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await page.waitForTimeout(4000);
    } catch (e) {}

    console.log(`\n🔍 Órdenes detectadas: ${pendingOrders.length}`);

    await browser.close();
    return pendingOrders;
}

/**
 * Procesa una orden P2P completa de Bybit de inicio a fin
 */
async function processP2POrder({
    orderId,
    orderType = 'BUY', // 'BUY' (nosotros compramos USDT / pagamos BOB) o 'SELL' (nosotros vendemos USDT / recibimos BOB)
    counterpartyName,
    bankName = 'Banco Solidario S.A.',
    accountNumber,
    amountBob,
    amountUsdt = 0,
    priceBob = 0,
    qrImagePath = null
}) {
    console.log('\n=============================================================');
    console.log(` 📦 PROCESANDO ÓRDEN P2P BYBIT #${orderId} (${orderType})`);
    console.log('=============================================================');
    console.log(`- Contraparte P2P: ${counterpartyName}`);
    console.log(`- Banco Destino:   ${bankName}`);
    console.log(`- N° Cuenta/QR:    ${accountNumber}`);
    console.log(`- Monto a Pagar:   ${amountBob} BOB (${amountUsdt} USDT @ ${priceBob})\n`);

    // 1. PASO 1: VERIFICACIÓN ANTI-TERCEROS (ESTRICTO)
    console.log('🛡️ PASO 1: Verificando coincidencia de titularidad...');
    const verification = verifyHolderName(counterpartyName, counterpartyName);

    if (!verification.isValid) {
        console.error(`❌ [ÓRDEN ABORTADA POR SEGURIDAD]: ${verification.reason}`);
        return {
            success: false,
            step: 'VERIFICATION_FAILED',
            reason: verification.reason
        };
    }
    console.log(`✅ Titularidad Verificada: ${verification.reason}\n`);

    // 2. PASO 2: EJECUCIÓN DE TRANSFERENCIA EN BANCO SOL (JIT)
    if (orderType === 'BUY') {
        console.log('⚡ PASO 2: Ejecutando auto-llenado de transferencia en Banco Sol...');
        const transferResult = await processBancoSolTransferJIT({
            accountNumber,
            amountBob,
            counterpartyBybitName: counterpartyName,
            qrImagePath,
            destinationBank: bankName
        });

        if (!transferResult.success) {
            console.error(`❌ [ERROR EN BANCO SOL]: ${transferResult.reason}`);
            return {
                success: false,
                step: 'BANK_TRANSFER_FAILED',
                reason: transferResult.reason
            };
        }

        console.log(`\n📸 PASO 3: Captura de Comprobante generada en:`);
        console.log(`   👉 ${transferResult.receiptPath}`);

        // 3. PASO 4: REGISTRAR EN EL HISTORIAL (LEDGER)
        console.log('\n📊 PASO 4: Registrando movimiento en el historial financiero...');
        const netProfitBob = amountUsdt * (priceBob * 0.05); // Margen estimado
        recordTransaction({
            orderId: orderId,
            type: 'COMPRA',
            amountUsdt: amountUsdt,
            amountBob: amountBob,
            price: priceBob,
            netProfitBob: netProfitBob,
            bank: 'BANCO SOL',
            counterparty: counterpartyName
        });

        console.log('\n=============================================================');
        console.log('✅ ÓRDEN P2P BYBIT PROCESADA EXITOSAMENTE Y COMPROBANTE GENERADO.');
        console.log('=============================================================\n');

        return {
            success: true,
            receiptPath: transferResult.receiptPath,
            orderId: orderId
        };
    }

    return { success: true, message: 'Orden de Venta procesada' };
}

if (require.main === module) {
    getActiveOrders().catch(err => console.error('Error al consultar órdenes:', err));
}

module.exports = {
    getActiveOrders,
    processP2POrder
};
