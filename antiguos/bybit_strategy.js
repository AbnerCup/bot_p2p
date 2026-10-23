/**
 * Motor de Estrategia de Precios Dinámicos para Bybit P2P
 * Aplica la regla estricta de MARGEN DE GANANCIA = 0.04 BOB por USDT.
 * Sincroniza volúmenes según el saldo de USDT en Bybit y el saldo Fiat en Banco Sol.
 */

const { scanBybitP2PMarket } = require('./bybit/market');
const { getLiveBybitUsdtBalance } = require('./bybit/balances');
const { getBancoSolLiveBalance } = require('./banks/bancosol');

const TARGET_MARGIN_BOB = 0.04; // Regla de margen solicitada: 0.04 BOB por USDT

/**
 * Calcula los precios y volúmenes óptimos para los anuncios de COMPRA y VENTA
 */
async function calculateOptimalAdPrices() {
    console.log('\n=============================================================');
    console.log(` 🎯 ANÁLISIS DE MERCADO Y ESTRATEGIA (MARGEN: ${TARGET_MARGIN_BOB} BOB)`);
    console.log('=============================================================');

    // 1. Escanear ofertas del mercado en tiempo real
    const market = await scanBybitP2PMarket();
    if (!market || !market.bestBuyPrice || !market.bestSellPrice) {
        console.error('⚠️ No se pudo obtener la información de mercado de Bybit.');
        return null;
    }

    // bestBuyPrice: Mejor precio al que VENDEDORES ofrecen USDT (Donde nosotros COMPRAMOS USDT)
    // bestSellPrice: Mejor precio al que COMPRADORES compran USDT (Donde nosotros VENDEMOS USDT)
    const marketTopBuyPrice = market.bestBuyPrice;   // Ej. 11.70 BOB
    const marketTopSellPrice = market.bestSellPrice; // Ej. 11.66 BOB

    // 2. Leer saldos reales
    const bybitUsdtBalance = await getLiveBybitUsdtBalance();
    const bancoSolBobBalance = await getBancoSolLiveBalance();

    console.log('\n=============================================================');
    console.log(' 💰 SALDOS DISPONIBLES REGISTRADOS');
    console.log('=============================================================');
    console.log(`🔹 Saldo USDT en Bybit (Billetera Fondos/Spot): ${bybitUsdtBalance.toFixed(2)} USDT`);
    console.log(`🔹 Saldo Fiat en Banco Sol (SolNet):          ${bancoSolBobBalance.toFixed(2)} BOB`);

    // 3. Aplicar regla de Margen de 0.04 BOB
    // Anuncio VENTA (Vendemos USDT por BOB):
    // Nos posicionamos competitivamente en la parte superior del mercado para vender USDT
    const targetSellPrice = (marketTopSellPrice + 0.001).toFixed(2);
    
    // Anuncio COMPRA (Compramos USDT pagando BOB):
    // Fijamos precio de compra para garantizar exactamente el margen de 0.04 BOB
    const targetBuyPrice = (parseFloat(targetSellPrice) - TARGET_MARGIN_BOB).toFixed(2);

    // 4. Calcular volúmenes disponibles por anuncio
    // VENTA: Usar TODO el saldo USDT disponible en Bybit
    const availableSellAmountUsdt = bybitUsdtBalance;

    // COMPRA: Usar el saldo Fiat en Banco Sol dividido entre el precio de compra
    const availableBuyAmountUsdt = targetBuyPrice > 0 ? (bancoSolBobBalance / parseFloat(targetBuyPrice)).toFixed(2) : 0;

    console.log('\n=============================================================');
    console.log(' 🚀 PRECIOS Y VOLÚMENES ÓPTIMOS CALCULADOS');
    console.log('=============================================================');
    console.log(`🟢 ANUNCIO DE COMPRA (Nosotros compramos USDT / Pagamos BOB):`);
    console.log(`   - Precio Sugerido: ${targetBuyPrice} BOB`);
    console.log(`   - Volumen USDT:    ${availableBuyAmountUsdt} USDT (Capacidad: ${bancoSolBobBalance} BOB)`);
    console.log(`   - Estado:          ${bancoSolBobBalance > 0 ? 'HABILITADO' : 'SUSPENDIDO (Saldo Banco Sol 0)'}`);

    console.log(`\n🔴 ANUNCIO DE VENTA (Nosotros vendemos USDT / Recibimos BOB):`);
    console.log(`   - Precio Sugerido: ${targetSellPrice} BOB`);
    console.log(`   - Volumen USDT:    ${availableSellAmountUsdt.toFixed(2)} USDT`);
    console.log(`   - Estado:          ${availableSellAmountUsdt > 0 ? 'HABILITADO' : 'SUSPENDIDO (Saldo USDT 0)'}`);

    console.log(`\n💵 MARGEN DE GANANCIA GARANTIZADO: ${TARGET_MARGIN_BOB.toFixed(2)} BOB por USDT`);
    console.log('=============================================================\n');

    return {
        targetMarginBob: TARGET_MARGIN_BOB,
        buyAd: {
            side: 'BUY',
            price: parseFloat(targetBuyPrice),
            amountUsdt: parseFloat(availableBuyAmountUsdt),
            fiatBalanceBob: bancoSolBobBalance,
            isEnabled: bancoSolBobBalance > 0
        },
        sellAd: {
            side: 'SELL',
            price: parseFloat(targetSellPrice),
            amountUsdt: parseFloat(availableSellAmountUsdt),
            cryptoBalanceUsdt: bybitUsdtBalance,
            isEnabled: availableSellAmountUsdt > 0
        }
    };
}

if (require.main === module) {
    calculateOptimalAdPrices().catch(err => console.error('Error en calculador de estrategia:', err));
}

module.exports = {
    TARGET_MARGIN_BOB,
    calculateOptimalAdPrices
};
