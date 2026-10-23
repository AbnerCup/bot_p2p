/**
 * Script interactivo para abrir la página oficial de Creación de Anuncios de Bybit P2P
 * (https://www.bybit.com/es-ES/p2p/advertiser/create)
 * y rellenar automáticamente todos los campos según el cálculo de mercado (Margen 0.04 BOB).
 */

const { fillBybitCreateAdForm } = require('./bybit/ads');
const { calculateOptimalAdPrices } = require('./bybit_strategy');

async function launchAdCreationAssistant() {
    console.log('\n=============================================================');
    console.log(' 🚀 ASISTENTE AUTOMÁTICO DE PUBLICACIÓN DE ANUNCIOS BYBIT P2P');
    console.log('=============================================================\n');

    // 1. Calcular precios óptimos de mercado con margen 0.04 BOB y saldos
    const strategy = await calculateOptimalAdPrices();

    if (!strategy) {
        console.error('❌ No se pudo obtener la estrategia de precios.');
        return;
    }

    const typeArg = process.argv[2] ? process.argv[2].toUpperCase() : 'BUY'; // 'BUY' o 'SELL'
    const targetAd = typeArg === 'SELL' ? strategy.sellAd : strategy.buyAd;

    console.log(`\n📌 Abriendo el navegador en https://www.bybit.com/es-ES/p2p/advertiser/create para anuncio de ${typeArg}...`);

    await fillBybitCreateAdForm({
        side: typeArg,
        price: targetAd.price,
        amountUsdt: targetAd.amountUsdt,
        headless: false // Abre la ventana del navegador visible para el usuario
    });
}

if (require.main === module) {
    launchAdCreationAssistant().catch(err => console.error('Error al abrir asistente de anuncios:', err));
}

module.exports = {
    launchAdCreationAssistant
};
