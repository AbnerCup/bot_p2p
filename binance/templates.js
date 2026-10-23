/**
 * Módulo de Plantillas de Anuncios P2P (Maker) y Respuestas Automáticas de Chat
 * Almacena las condiciones de seguridad, instrucciones y chat automático para Binance P2P.
 */

const AD_TEMPLATES = {
    BUY: {
        type: 'BUY',
        title: 'Anuncio de COMPRA de USDT (Tú compras USDT / El usuario te vende)',
        suggestedPrice: 10.80,
        terms: `🟢 ¡Hola! Bienvenido/a.

📍 REGLAS DE SEGURIDAD OBLIGATORIAS:

SOLO TITULARES: La cuenta bancaria desde la que transfieres DEBE estar a tu mismo nombre registrado en la plataforma.

🚫 NO SE ACEPTAN PAGOS DE TERCEROS (Esposos, familiares, amigos o cuentas de empresas no titulares). Si pagas desde una cuenta de tercero, el pago será rechazado y devuelto a costa del comprador.

Una vez hecha la transferencia, adjunta la captura o comprobante digital legible en el chat.

Proceso rápido y seguro. ¡Gracias por tu preferencia!`,
        autoReply: `¡Hola! Gracias por iniciar la orden.

Para proceder rápidamente, por favor envíame tu
Código QR 

Quedo a la espera de tu mensaje gracias, apenas confirme en mi banca te mando la captura.`
    },
    SELL: {
        type: 'SELL',
        title: 'Anuncio de VENTA de USDT (Tú vendes USDT / El usuario te paga por QR)',
        suggestedPrice: 10.83,
        terms: `🟢 ¡Hola! Servicio rápido 24/7.

📍 INSTRUCCIONES Y CONDICIONES:

Pago inmediato por Código QR (Simple) o transferencia bancaria directa.
TITULARIDAD ESTRICTA: El titular de la cuenta bancaria pagadora debe ser 100% el mismo que el de la cuenta P2P.

Al pagar, adjunta la captura clara del comprobante bancario.

Verifico en la app bancaria en tiempo real y libero tus USDT al instante.`,
        autoReply: `¡Hola! Gracias por tu compra. ⚡

📲 PAGO POR CÓDIGO QR / SIMPLE:
[Se adjunta automáticamente la imagen del Código QR de cobro]

⚠️ RECUERDA:
* No acepto pagos de terceros.
* En la glosa de la transferencia NO coloques palabras relacionadas con criptomonedas.

Envía la captura del comprobante por aquí apenas transfieras y le das al botón "Pago Realizado". ¡Libero de inmediato!`
    }
};

/**
 * Calcula los precios recomendados para COMPRA y VENTA según el escaneo de mercado en vivo
 */
function calculateMakerPrices(marketScan, targetMarginBob = 0.03) {
    if (!marketScan) {
        return { buyPrice: 10.80, sellPrice: 10.83, marginBob: 0.03 };
    }

    const bestBuyInMarket = marketScan.bestBuyPrice || 10.90;  // Vendedores top
    const bestSellInMarket = marketScan.bestSellPrice || 10.84; // Compradores top

    // Estrategia Maker:
    // Para COMPRAR USDT (pones anuncio de compra): Posicionarse competitivo frente al top
    let buyPrice = parseFloat((bestBuyInMarket - 0.01).toFixed(2));
    if (buyPrice > 10.80) buyPrice = 10.80; // Precio competitivo seguro

    // Para VENDER USDT (pones anuncio de venta): Posicionarse con margen mínimo de 0.03 BOB
    let sellPrice = parseFloat((buyPrice + targetMarginBob).toFixed(2));
    if (sellPrice < 10.83) sellPrice = 10.83;

    return {
        buyPrice: buyPrice.toFixed(2),
        sellPrice: sellPrice.toFixed(2),
        marginBob: (sellPrice - buyPrice).toFixed(2)
    };
}

module.exports = {
    AD_TEMPLATES,
    calculateMakerPrices
};
