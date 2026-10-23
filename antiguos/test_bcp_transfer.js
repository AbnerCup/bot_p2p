const { processP2POrder } = require('./binance/orders');

(async () => {
    console.log('\n=============================================================');
    console.log(' 🚀 EJECUTANDO PRUEBA REAL: AUTO-LLENADO BCP (5.00 BOB)');
    console.log('=============================================================');
    console.log('- Banco Destino: Banco de Crédito de Bolivia S.A. (BCP)');
    console.log('- N° Cuenta:    40151438282343');
    console.log('- Beneficiario: Copa Lopez Abner Jose');
    console.log('- Monto:        5.00 BOB\n');

    const result = await processP2POrder({
        orderId: 'TEST-BCP-5BOB-' + Date.now(),
        orderType: 'BUY',
        counterpartyName: 'ABNER COPA',
        bankName: 'Banco de Crédito de Bolivia S.A.',
        accountNumber: '40151438282343',
        amountBob: 5.00,
        amountUsdt: 0.46,
        priceBob: 10.90
    });

    console.log('\n--- RESULTADO DE LA PRUEBA ---');
    console.log(JSON.stringify(result, null, 2));
})();
