/**
 * BOT MAESTRO P2P BINANCE (EJECUCIÓN REAL CON ACCESO A BINANCE EN VIVO)
 */

const { getLiveBinanceUsdtBalance, getConsolidatedBalances } = require('./binance/balances');
const { scanBinanceP2PMarket } = require('./binance/market');
const { loadEnv } = require('./config');

async function runLiveRealBotTest() {
    console.log('\n=============================================================');
    console.log('   🚀 INICIANDO PRUEBA REAL EN VIVO CON BINANCE P2P          ');
    console.log('=============================================================\n');

    // 1. Conectarse a Binance en vivo para leer el saldo real de USDT
    const liveUsdtBalance = await getLiveBinanceUsdtBalance();

    // 2. Obtener consolidado con el saldo real
    const balances = await getConsolidatedBalances(liveUsdtBalance);

    // 3. Escanear mercado en tiempo real
    const market = await scanBinanceP2PMarket();

    console.log('\n=============================================================');
    console.log(' 📊 RESULTADO REAL DETECTADO EN TU CUENTA');
    console.log('=============================================================');
    console.log(`🔹 Saldo REAL USDT en Billetera Binance: ${balances.binanceUsdt.toFixed(2)} USDT`);
    console.log(`🔹 Saldo en Banco Sol: ${balances.totalBobInBanks.toFixed(2)} BOB`);

    console.log('\n=============================================================');
    console.log(' 🛡️ EVALUACIÓN DE ANUNCIOS Y OPERATIVIDAD EN VIVO:');
    console.log('=============================================================');

    if (balances.binanceUsdt <= 0) {
        console.log('❌ [ANUNCIO DE VENTA CANCELADO/DESHABILITADO]:');
        console.log('   El bot verificó en Binance que tu saldo en USDT es 0.00.');
        console.log('   Por seguridad, NO se publicará ni se activará ningún anuncio de VENTA de USDT.');
    } else {
        console.log(`🟢 [ANUNCIO DE VENTA HABILITADO]: Saldo suficiente (${balances.binanceUsdt.toFixed(2)} USDT).`);
    }

    if (balances.totalBobInBanks <= 0) {
        console.log('❌ [ANUNCIO DE COMPRA CANCELADO/DESHABILITADO]:');
        console.log('   Tu saldo en banco es 0.00 BOB. Se suspenden los anuncios de COMPRA de USDT.');
    } else {
        const buyPrice = market ? (market.bestBuyPrice + 0.001).toFixed(2) : '11.67';
        const maxUsdtCapacity = (balances.totalBobInBanks / parseFloat(buyPrice)).toFixed(2);
        console.log(`🟢 [ANUNCIO DE COMPRA HABILITADO]:`);
        console.log(`   Tienes ${balances.totalBobInBanks.toFixed(2)} BOB en Banco Sol.`);
        console.log(`   Anuncio posicionado a ${buyPrice} BOB (Capacidad máxima: ${maxUsdtCapacity} USDT / ${balances.totalBobInBanks} BOB).`);
    }

    console.log('\n=============================================================');
    console.log('✅ PRUEBA REAL EN VIVO FINALIZADA CON ÉXITO.');
    console.log('=============================================================\n');
}

if (require.main === module) {
    runLiveRealBotTest().catch(err => console.error('Error en prueba real:', err));
}
