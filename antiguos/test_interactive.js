/**
 Script de Prueba Interactiva y Segura (Paso a Paso)
 Permite verificar la automatización, filtros anti-terceros y plantillas de anuncios Maker.
*/

const readline = require('readline');
const { processP2POrder } = require('./binance/orders');
const { verifyHolderName } = require('./security/verifier');
const { AD_TEMPLATES, calculateMakerPrices } = require('./binance/templates');
const { scanBinanceP2PMarket } = require('./binance/market');
const { publishMakerAd } = require('./binance/ads_manager');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function startStepByStepTest() {
    console.log('\n=============================================================');
    console.log(' 🛡️  MÓDULO DE PRUEBA DE FUEGO Y GESTIÓN DE ANUNCIOS MAKER  ');
    console.log('=============================================================');
    console.log('Selecciona qué opción deseas ejecutar:\n');
    console.log('1️⃣  Monitor Asistente en Vivo (Precios cada segundo + Decisiones + Vigía de Órdenes)');
    console.log('2️⃣  Prueba de Seguridad Anti-Terceros (Verificación de Titularidad - Sin Banco)');
    console.log('3️⃣  Prueba de Auto-Llenado Visible en Banco Sol / BCP (Monto de prueba: 1.00 BOB)');
    console.log('4️⃣  Ver Plantillas de Términos y Respuestas Automáticas de Chat');
    console.log('5️⃣  Publicar / Configurar Anuncio Maker en Binance (Visible)');
    console.log('0️⃣  Salir\n');

    const choice = await askQuestion('👉 Ingresa el número de opción (1-5): ');

    if (choice === '1') {
        rl.close();
        const { runRealTimeMonitoringLoop } = require('./binance_monitor');
        await runRealTimeMonitoringLoop();
        return;
    } else if (choice === '2') {
        console.log('\n-------------------------------------------------------------');
        console.log(' 🧪 PRUEBA 2: VERIFICACIÓN ANTI-TERCEROS');
        console.log('-------------------------------------------------------------');
        console.log('Escenario: El usuario en Binance se llama "JUAN PEREZ", pero la cuenta bancaria pertenece a "MARIA LOPEZ".');
        const res = verifyHolderName('JUAN PEREZ', 'MARIA LOPEZ');
        console.log('\nResultado de Seguridad:', res);
        if (!res.isValid) {
            console.log('\n✅ ÉXITO: El bot detectó la discrepancia de nombres y ABORTÓ la transacción antes de tocar el banco.');
        }
    } else if (choice === '3') {
        console.log('\n-------------------------------------------------------------');
        console.log(' 🧪 PRUEBA 3: AUTO-LLENADO VISIBLE EN BANCO SOL (1.00 BOB)');
        console.log('-------------------------------------------------------------');
        console.log('📌 Se abrirá una ventana de navegador VISIBLE.');
        console.log('📌 El bot ingresará a Banco Sol y rellenará únicamente los datos por 1.00 BOB.');
        console.log('📌 El bot SE DETENDRÁ antes de confirmar la transferencia para que tú revises la pantalla.\n');

        const confirm = await askQuestion('¿Deseas iniciar la apertura del navegador visible? (s/n): ');
        if (confirm.toLowerCase() === 's') {
            await processP2POrder({
                orderId: 'TEST-PRUEBA-1BOB',
                orderType: 'BUY',
                counterpartyName: 'ROJAS AGUILAR CRISTIAN GONZALO',
                bankName: 'Banco de Crédito (BCP)',
                accountNumber: '1091873472',
                amountBob: 1.00,
                amountUsdt: 0.09,
                priceBob: 11.28
            });
        }
    } else if (choice === '4') {
        console.log('\n-------------------------------------------------------------');
        console.log(' 📋 PLANTILLAS DE ANUNCIOS MAKER CONFIGURADAS');
        console.log('-------------------------------------------------------------');
        
        const market = await scanBinanceP2PMarket();
        const pricing = calculateMakerPrices(market);

        console.log(`\n💰 ANÁLISIS DINÁMICO DE PRECIOS SUGERIDOS:`);
        console.log(`🟢 Precio Anuncio COMPRA: ${pricing.buyPrice} BOB (Tú compras a ${pricing.buyPrice})`);
        console.log(`🔴 Precio Anuncio VENTA:  ${pricing.sellPrice} BOB (Tú vendes a ${pricing.sellPrice})`);
        console.log(`📈 Margen de Ganancia:   ${pricing.marginBob} BOB por USDT\n`);

        console.log('=============================================================');
        console.log('1. PLANTILLA COMPRA (Tú compras USDT / El usuario te vende)');
        console.log('=============================================================');
        console.log('📜 TÉRMINOS:\n' + AD_TEMPLATES.BUY.terms);
        console.log('\n💬 CHAT AUTOMÁTICO DE BIENVENIDA:\n' + AD_TEMPLATES.BUY.autoReply);

        console.log('\n=============================================================');
        console.log('2. PLANTILLA VENTA (Tú vendes USDT / El usuario te paga por QR)');
        console.log('=============================================================');
        console.log('📜 TÉRMINOS:\n' + AD_TEMPLATES.SELL.terms);
        console.log('\n💬 CHAT AUTOMÁTICO DE BIENVENIDA:\n' + AD_TEMPLATES.SELL.autoReply);
    } else if (choice === '5') {
        console.log('\n-------------------------------------------------------------');
        console.log(' 📢 PUBLICACIÓN / CONFIGURACIÓN DE ANUNCIO EN BINANCE');
        console.log('-------------------------------------------------------------');
        const typeChoice = await askQuestion('¿Qué anuncio deseas configurar? (1: COMPRA / 2: VENTA): ');
        const adType = typeChoice === '2' ? 'SELL' : 'BUY';
        
        await publishMakerAd({
            type: adType,
            totalUsdtAmount: 10.00,
            minLimitBob: 55
        });
    }

    rl.close();
}

if (require.main === module) {
    startStepByStepTest();
}
