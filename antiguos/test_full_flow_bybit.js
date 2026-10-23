/**
 * Script de Verificación del Flujo Completo Bybit:
 * 1. Detección de Orden P2P Bybit
 * 2. Verificación Estricta Anti-Terceros (Titularidad)
 * 3. Auto-Llenado de Formulario en Banco Sol (A otros bancos / Mismo banco)
 * 4. Generación y Adjunto de Comprobante (comprobante_bancosol.png)
 * 5. Registro Histórico de Ganancias (history.json)
 */

const { processP2POrder } = require('./bybit/orders');

(async () => {
    console.log('====================================================');
    console.log('   🚀 PRUEBA DE FLUJO COMPLETO: BYBIT P2P -> BANCO SOL  ');
    console.log('====================================================\n');

    const result = await processP2POrder({
        orderId: 'BYBIT-' + Date.now(),
        orderType: 'BUY',
        counterpartyName: 'ABNER COPA',
        bankName: 'Banco Mercantil Santa Cruz S.A.',
        accountNumber: '100000012345',
        amountBob: 15.00,
        amountUsdt: 1.28,
        priceBob: 11.74
    });

    console.log('\n--- RESULTADO DE PRUEBA DE FLUJO COMPLETO BYBIT ---');
    console.log(JSON.stringify(result, null, 2));
})();
