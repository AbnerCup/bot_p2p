/**
 * Módulo de Estrategia de Precios y Decisiones Binance P2P (Perspectiva MAKER)
 * 
 * Regla de Oro del Comerciante P2P: COMPRAR BARATO Y VENDER CARO.
 * 
 * En la API de búsqueda de Binance P2P:
 * - Para COMPRAR USDT BARATO (Anuncio Maker de Compra):
 *   Se compite contra la lista de compradores (API tradeType: 'SELL', advType: 'BUY').
 *   Precios típicos más bajos: ~10.90 - 10.93 BOB.
 * 
 * - Para VENDER USDT CARO (Anuncio Maker de Venta):
 *   Se compite contra la lista de vendedores (API tradeType: 'BUY', advType: 'SELL').
 *   Precios típicos más altos: ~11.02 - 11.05 BOB.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../history.json');

/**
 * Obtiene el costo base de compra reciente desde history.json
 */
function getRecentPurchaseCostBasis(fallbackPrice = 10.90) {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return fallbackPrice;
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        
        // Filtrar compras exitosas
        const purchases = history.filter(h => h.type === 'COMPRA' && h.status === 'EXITOSO' && h.price > 0);
        if (purchases.length === 0) return fallbackPrice;

        // Tomar las últimas compras para calcular el costo promedio ponderado
        const recent = purchases.slice(-5);
        let totalBob = 0;
        let totalCrypto = 0;
        recent.forEach(p => {
            const crypto = p.cryptoAmount || (p.fiatAmount / p.price);
            totalBob += (p.fiatAmount || (crypto * p.price));
            totalCrypto += crypto;
        });

        if (totalCrypto > 0) {
            return parseFloat((totalBob / totalCrypto).toFixed(3));
        }

        return parseFloat(recent[recent.length - 1].price);
    } catch (e) {
        return fallbackPrice;
    }
}

/**
 * Analiza las ofertas de mercado y genera las sugerencias exactas:
 * @param {Array} makerBuyAds - Anuncios donde los competidores compran USDT (API tradeType: 'SELL')
 * @param {Array} makerSellAds - Anuncios donde los competidores venden USDT (API tradeType: 'BUY')
 */
function calculateStrategicRecommendations(makerBuyAds = [], makerSellAds = []) {
    // -------------------------------------------------------------
    // 1. ANÁLISIS PARA COMPRAR USDT BARATO (Tú como Comprador Maker)
    // -------------------------------------------------------------

    // Filtrar anuncios institucionales con montos mínimos gigantescos (> 30,000 Bs)
    const retailBuyAds = makerBuyAds.filter(item => {
        if (!item || !item.adv) return false;
        const minAmount = parseFloat(item.adv.minSingleTransAmount || 0);
        return minAmount < 30000;
    });

    const buyPriceFrequency = {};
    let sumBuy = 0;
    let validBuyCount = 0;

    retailBuyAds.forEach(item => {
        const p = parseFloat(item.adv.price).toFixed(2);
        buyPriceFrequency[p] = (buyPriceFrequency[p] || 0) + 1;
        sumBuy += parseFloat(p);
        validBuyCount++;
    });

    const mediaBuy = validBuyCount > 0 ? parseFloat((sumBuy / validBuyCount).toFixed(3)) : 11.27;

    // Encontrar el precio más popular de COMPRA (concurrencia de anuncios)
    let mostPopularBuyPrice = null;
    let maxBuyFreq = 0;
    for (const [priceStr, count] of Object.entries(buyPriceFrequency)) {
        if (count > maxBuyFreq) {
            maxBuyFreq = count;
            mostPopularBuyPrice = parseFloat(priceStr);
        }
    }
    if (!mostPopularBuyPrice) mostPopularBuyPrice = mediaBuy;

    // Límite mínimo en BOB para amortizar comisión (35 * media actual de compra)
    const minOrderLimitBob = parseFloat((35 * mediaBuy).toFixed(2));

    // -------------------------------------------------------------
    // 2. ANÁLISIS PARA VENDER USDT CARO (Tú como Vendedor Maker)
    // -------------------------------------------------------------
    const retailSellAds = makerSellAds.filter(item => {
        if (!item || !item.adv) return false;
        const minAmount = parseFloat(item.adv.minSingleTransAmount || 0);
        return minAmount < 30000;
    });

    let sumSell = 0;
    let validSellCount = 0;
    const sellPriceFrequency = {};

    retailSellAds.forEach(item => {
        const p = parseFloat(item.adv.price).toFixed(2);
        sellPriceFrequency[p] = (sellPriceFrequency[p] || 0) + 1;
        sumSell += parseFloat(p);
        validSellCount++;
    });

    const mediaSell = validSellCount > 0 ? parseFloat((sumSell / validSellCount).toFixed(3)) : 11.32;
    const bestSellInMarket = retailSellAds[0] ? parseFloat(retailSellAds[0].adv.price) : mediaSell;

    // -------------------------------------------------------------
    // 3. COSTO BASE Y PREVENCIÓN DE PÉRDIDAS (SIEMPRE VENDER MÁS CARO)
    // -------------------------------------------------------------
    // Costo base real de adquisición (o el precio de compra popular actual si no hay compras)
    const costBasis = getRecentPurchaseCostBasis(mostPopularBuyPrice);
    
    // Piso mínimo de seguridad: Al menos +0.04 BOB por encima de lo que te costó
    const minSafeSellPrice = parseFloat((costBasis + 0.04).toFixed(2));

    // Precio de venta sugerido: Competir en la punta alta del mercado de venta
    // Si la media o mejor venta del mercado es más alta (ej: 11.02 o en las noches 11.05+), usamos el precio de mercado
    let suggestedSellPrice = Math.max(minSafeSellPrice, bestSellInMarket);
    let sellReason = 'Mejor precio competitivo de venta';

    if (mediaSell > bestSellInMarket) {
        suggestedSellPrice = Math.max(minSafeSellPrice, mediaSell);
        sellReason = 'Media nocturna del mercado (Margen expandido)';
    }

    if (suggestedSellPrice < minSafeSellPrice) {
        suggestedSellPrice = minSafeSellPrice;
        sellReason = 'Margen mínimo de protección (+0.04 BOB)';
    }

    // Margen neto real proyectado (Vender Caro - Costo Base)
    const referenceCost = costBasis > 0 ? costBasis : mostPopularBuyPrice;
    const netMarginBob = parseFloat((suggestedSellPrice - referenceCost).toFixed(3));
    const marginPercent = parseFloat(((netMarginBob / referenceCost) * 100).toFixed(2));

    return {
        // Compra Barata
        suggestedBuyPrice: mostPopularBuyPrice.toFixed(2),
        popularBuyCount: maxBuyFreq,
        mediaBuy: mediaBuy.toFixed(2),
        minOrderLimitBob: minOrderLimitBob,
        
        // Venta Cara
        costBasis: costBasis.toFixed(2),
        minSafeSellPrice: minSafeSellPrice.toFixed(2),
        mediaSell: mediaSell.toFixed(2),
        bestSellInMarket: bestSellInMarket.toFixed(2),
        suggestedSellPrice: suggestedSellPrice.toFixed(2),
        
        // Margen Real Positivo
        netMarginBob: netMarginBob.toFixed(2),
        marginPercent: marginPercent,
        sellReason: sellReason,

        // Frecuencias
        buyPriceFrequency,
        sellPriceFrequency
    };
}

module.exports = {
    getRecentPurchaseCostBasis,
    calculateStrategicRecommendations
};
