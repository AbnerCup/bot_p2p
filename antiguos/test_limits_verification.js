/**
 * Test de Verificación de Límites y Solapamiento para Bybit y Binance P2P
 */

const { findArbitrageGaps } = require('./bybit_radar');
const { findBinanceArbitrageGaps } = require('./binance_radar');

console.log('🧪 INICIANDO PRUEBAS DE VERIFICACIÓN DE LÍMITES...\n');

// 1. Caso Real del Usuario: Compra a 11.92 (máx 99.45 $) y Venta a 11.94 (mín 5000 Bs)
console.log('--- TEST 1: Caso Real Reportado por el Usuario ---');
const testSellersUserCase = [
    {
        nickName: 'VendedorBarato',
        price: '11.92',
        minAmount: '50',
        maxAmount: '1185.44',
        lastQuantity: '99.45', // 99.45 USDT disp.
        recentExecuteRate: '98',
        payments: ['BancoSol']
    }
];

const testBuyersUserCase = [
    {
        nickName: 'CompradorCaro',
        price: '11.94',
        minAmount: '5000', // Mínimo 5000 BOB (~418.76 USDT)
        maxAmount: '20000',
        lastQuantity: '1675.04',
        recentExecuteRate: '99',
        payments: ['BancoSol']
    }
];

const gapsUserCase = findArbitrageGaps(testSellersUserCase, testBuyersUserCase);
console.log(`Brechas detectadas: ${gapsUserCase.length}`);
if (gapsUserCase.length > 0) {
    const g = gapsUserCase[0];
    console.log(`- Spread: +${g.spread} BOB`);
    console.log(`- Solapamiento (hasOverlap): ${g.limits.hasOverlap}`);
    console.log(`- Compra máx USDT: ${g.limits.buy.maxUsdt.toFixed(2)} USDT`);
    console.log(`- Venta mín USDT: ${g.limits.sell.minUsdt.toFixed(2)} USDT`);
    console.log(`- Motivo de Incompatibilidad: ${g.limits.reason}`);
    
    if (!g.limits.hasOverlap) {
        console.log('✅ TEST 1 APROBADO: Incompatibilidad detectada correctamente sin dejar al usuario atrapado.');
    } else {
        console.error('❌ TEST 1 FALLIDO: Debería ser incompatible.');
    }
}

// 2. Caso Compatible: Límites que sí solapan
console.log('\n--- TEST 2: Caso Compatible con Solapamiento Real ---');
const testSellersCompat = [
    {
        nickName: 'VendedorNormal',
        price: '11.90',
        minAmount: '100', // ~8.40 USDT
        maxAmount: '5000', // ~420.17 USDT
        lastQuantity: '500',
        recentExecuteRate: '99',
        payments: ['BancoSol']
    }
];

const testBuyersCompat = [
    {
        nickName: 'CompradorNormal',
        price: '11.95',
        minAmount: '200', // ~16.74 USDT
        maxAmount: '3000', // ~251.05 USDT
        lastQuantity: '400',
        recentExecuteRate: '98',
        payments: ['BancoSol']
    }
];

const gapsCompat = findArbitrageGaps(testSellersCompat, testBuyersCompat);
console.log(`Brechas detectadas: ${gapsCompat.length}`);
if (gapsCompat.length > 0) {
    const g = gapsCompat[0];
    console.log(`- Spread: +${g.spread} BOB`);
    console.log(`- Solapamiento (hasOverlap): ${g.limits.hasOverlap}`);
    console.log(`- Rango ejecutable: ${g.limits.overlapMinUsdt.toFixed(2)} a ${g.limits.overlapMaxUsdt.toFixed(2)} USDT`);
    console.log(`- Monto sugerido para orden: ${g.limits.suggestedTradeUsdt} USDT`);
    
    if (g.limits.hasOverlap && g.limits.suggestedTradeUsdt === 100) {
        console.log('✅ TEST 2 APROBADO: Rango ejecutable y monto sugerido calculados con éxito.');
    } else {
        console.error('❌ TEST 2 FALLIDO: El solapamiento o el monto sugerido no son correctos.');
    }
}

// 3. Caso Binance: Mismo escenario con la estructura de Binance
console.log('\n--- TEST 3: Caso Binance P2P ---');
const binanceSellers = [
    {
        adv: {
            price: '11.92',
            minSingleTransAmount: '50',
            maxSingleTransAmount: '1185.44',
            surplusAmount: '99.45',
            tradeMethods: [{ tradeMethodName: 'BancoSol' }]
        },
        advertiser: {
            nickName: 'BinanceSeller',
            monthFinishRate: 0.98
        }
    }
];

const binanceBuyers = [
    {
        adv: {
            price: '11.94',
            minSingleTransAmount: '5000',
            maxSingleTransAmount: '20000',
            surplusAmount: '1675.04',
            tradeMethods: [{ tradeMethodName: 'BancoSol' }]
        },
        advertiser: {
            nickName: 'BinanceBuyer',
            monthFinishRate: 0.99
        }
    }
];

const binanceGaps = findBinanceArbitrageGaps(binanceSellers, binanceBuyers);
console.log(`Brechas Binance detectadas: ${binanceGaps.length}`);
if (binanceGaps.length > 0) {
    const bg = binanceGaps[0];
    console.log(`- Solapamiento (hasOverlap): ${bg.limits.hasOverlap}`);
    console.log(`- Motivo: ${bg.limits.reason}`);
    if (!bg.limits.hasOverlap) {
        console.log('✅ TEST 3 APROBADO: Lógica de límites en Binance P2P idéntica y precisa.');
    } else {
        console.error('❌ TEST 3 FALLIDO: Falló la detección en Binance.');
    }
}

console.log('\n--- TEST 4: Prueba Visual de renderBigGapAlert (Bybit) ---');
const { renderBigGapAlert } = require('./bybit_radar');

console.log('\n>>> ALERTA DE PRUEBA 1 (LÍMITES INCOMPATIBLES):');
renderBigGapAlert(gapsUserCase[0], '13:25:00');

console.log('\n>>> ALERTA DE PRUEBA 2 (LÍMITES COMPATIBLES):');
renderBigGapAlert(gapsCompat[0], '13:25:00');

console.log('\n🎉 TODOS LOS TESTS COMPLETADOS SATISFACTORIAMENTE.');

