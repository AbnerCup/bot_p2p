/**
 * Script de Verificación del Flujo Completo:
 * 1. Detección de Orden P2P
 * 2. Verificación Estricta Anti-Terceros (Titularidad)
 * 3. Auto-Llenado de Formulario en Banco Sol (A otros bancos / Mismo banco)
 * 4. Generación y Adjunto de Comprobante (comprobante_bancosol.png)
 * 5. Registro Histórico de Ganancias (history.json)
 */

const { processP2POrder } = require('./binance/orders');

(async () => {
    console.log('====================================================');
    console.log('   🚀 PRUEBA DE FLUJO COMPLETO: BINANCE P2P -> BANCO SOL  ');
    console.log('====================================================\n');

    const result = await processP2POrder({
        orderId: 'BNB-' + Date.now(),
        orderType: 'BUY',
        counterpartyName: 'ABNER COPA',
        bankName: 'Banco Mercantil Santa Cruz S.A.',
        accountNumber: '100000012345',
        amountBob: 15.00,
        amountUsdt: 1.30,
        priceBob: 11.54
    });

    console.log('\n--- RESULTADO DE PRUEBA DE FLUJO COMPLETO ---');
    console.log(JSON.stringify(result, null, 2));
})();

