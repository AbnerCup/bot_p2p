/**
 * BOT MAESTRO P2P BYBIT (EJECUCIÓN REAL CON ACCESO A BYBIT EN VIVO)
 */

const { runRealTimeBybitMonitoringLoop } = require('./bybit_monitor');
const { getLiveBybitUsdtBalance, getConsolidatedBalances } = require('./bybit/balances');
const { scanBybitP2PMarket } = require('./bybit/market');
const { loadEnv } = require('./config');

async function runLiveRealBybitBotTest() {
    console.log('\n=============================================================');
    console.log('   🚀 INICIANDO BOT MAESTRO BYBIT P2P + BANCO SOL            ');
    console.log('=============================================================\n');

    // 1. Conectarse a Bybit en vivo para leer el saldo real de USDT vía API
    const liveUsdtBalance = await getLiveBybitUsdtBalance();

    // 2. Obtener consolidado con el saldo real
    const balances = await getConsolidatedBalances(liveUsdtBalance);

    // 3. Escanear mercado en tiempo real
    const market = await scanBybitP2PMarket();

    console.log('\n=============================================================');
    console.log(' 📊 RESULTADO REAL DETECTADO EN TU CUENTA (BYBIT API)');
    console.log('=============================================================');
    console.log(`🔹 Saldo REAL USDT en Billetera Bybit: ${balances.bybitUsdt.toFixed(2)} USDT`);
    console.log(`🔹 Saldo en Banco Sol: ${balances.totalBobInBanks.toFixed(2)} BOB`);

    console.log('\n=============================================================');
    console.log(' 🛡️ EVALUACIÓN DE ANUNCIOS Y OPERATIVIDAD EN VIVO:');
    console.log('=============================================================');

    if (balances.bybitUsdt <= 0) {
        console.log('❌ [ANUNCIO DE VENTA CANCELADO/DESHABILITADO]:');
        console.log('   El bot verificó en Bybit que tu saldo en USDT es 0.00.');
        console.log('   Por seguridad, NO se publicará ni se activará ningún anuncio de VENTA de USDT.');
    } else {
        console.log(`🟢 [ANUNCIO DE VENTA HABILITADO]: Saldo suficiente (${balances.bybitUsdt.toFixed(2)} USDT).`);
    }

    if (balances.totalBobInBanks <= 0) {
        console.log('❌ [ANUNCIO DE COMPRA CANCELADO/DESHABILITADO]:');
        console.log('   Tu saldo en banco es 0.00 BOB. Se suspenden los anuncios de COMPRA de USDT.');
    } else {
        const buyPrice = market ? (market.bestBuyPrice + 0.001).toFixed(2) : '11.74';
        const maxUsdtCapacity = (balances.totalBobInBanks / parseFloat(buyPrice)).toFixed(2);
        console.log(`🟢 [ANUNCIO DE COMPRA HABILITADO]:`);
        console.log(`   Tienes ${balances.totalBobInBanks.toFixed(2)} BOB en Banco Sol.`);
        console.log(`   Anuncio posicionado a ${buyPrice} BOB (Capacidad máxima: ${maxUsdtCapacity} USDT / ${balances.totalBobInBanks} BOB).`);
    }

    console.log('\n=============================================================');
    console.log('✅ BOT MAESTRO P2P BYBIT + BANCO SOL LISTO Y AUTENTICADO.');
    console.log('=============================================================\n');
}

if (require.main === module) {
    if (process.argv.includes('--once')) {
        runLiveRealBybitBotTest().catch(err => console.error('Error en prueba Bybit:', err));
    } else {
        // Por defecto o con --loop: Iniciar Monitor en Tiempo Real Continuo
        runRealTimeBybitMonitoringLoop().catch(err => console.error('Error en monitor loop:', err));
    }
}

module.exports = {
    runLiveRealBybitBotTest
};

