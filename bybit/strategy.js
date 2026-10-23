/**
 * Módulo de Estrategia de Precios y Decisiones Bybit P2P (Perspectiva MAKER)
 * 
 * Regla de Oro del Comerciante P2P: COMPRAR BARATO Y VENDER CARO.
 * 
 * En el libro de ofertas de Bybit P2P:
 * - Para COMPRAR USDT BARATO (Anuncio Maker de Compra - Pagamos BOB):
 *   Se compite contra la lista de compradores de USDT (side '0' en API pública).
 * - Para VENDER USDT CARO (Anuncio Maker de Venta - Recibimos BOB):
 *   Se compite contra la lista de vendedores de USDT (side '1' en API pública).
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../history.json');

/**
 * Obtiene el costo base de compra reciente desde history.json
 */
function getRecentPurchaseCostBasis(fallbackPrice = 11.60) {
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
 * Analiza las ofertas del mercado Bybit y genera sugerencias estratégicas exactas:
 * @param {Array} competitorBuyers - Compradores compitiendo en el mercado (Donde tú vendes USDT)
 * @param {Array} competitorSellers - Vendedores compitiendo en el mercado (Donde tú compras USDT)
 */
function calculateBybitStrategicRecommendations(competitorBuyers = [], competitorSellers = []) {
    // -------------------------------------------------------------
    // 1. ANÁLISIS PARA COMPRAR USDT BARATO (Tú como Comprador Maker)
    // -------------------------------------------------------------
    // Filtrar anuncios institucionales con montos mínimos gigantescos (> 30,000 Bs)
    const retailBuyAds = competitorBuyers.filter(item => {
        if (!item) return false;
        const minAmount = parseFloat(item.minAmount || 0);
        return minAmount < 30000;
    });

    const buyPriceFrequency = {};
    let sumBuy = 0;
    let validBuyCount = 0;

    retailBuyAds.forEach(item => {
        const p = parseFloat(item.price).toFixed(2);
        buyPriceFrequency[p] = (buyPriceFrequency[p] || 0) + 1;
        sumBuy += parseFloat(p);
        validBuyCount++;
    });

    const mediaBuy = validBuyCount > 0 ? parseFloat((sumBuy / validBuyCount).toFixed(3)) : 11.62;

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

    // Para comprar competitivamente en la parte superior:
    const bestBuyerPrice = retailBuyAds[0] ? parseFloat(retailBuyAds[0].price) : mostPopularBuyPrice;
    // Sugerencia: competir ligeramente por encima del mejor o en el precio popular
    const suggestedBuyPrice = parseFloat(Math.max(mostPopularBuyPrice, bestBuyerPrice).toFixed(2));

    // Límite mínimo en BOB
    const minOrderLimitBob = 50.00;

    // -------------------------------------------------------------
    // 2. ANÁLISIS PARA VENDER USDT CARO (Tú como Vendedor Maker)
    // -------------------------------------------------------------
    const retailSellAds = competitorSellers.filter(item => {
        if (!item) return false;
        const minAmount = parseFloat(item.minAmount || 0);
        return minAmount < 30000;
    });

    let sumSell = 0;
    let validSellCount = 0;
    const sellPriceFrequency = {};

    retailSellAds.forEach(item => {
        const p = parseFloat(item.price).toFixed(2);
        sellPriceFrequency[p] = (sellPriceFrequency[p] || 0) + 1;
        sumSell += parseFloat(p);
        validSellCount++;
    });

    const mediaSell = validSellCount > 0 ? parseFloat((sumSell / validSellCount).toFixed(3)) : 11.72;
    const bestSellInMarket = retailSellAds[0] ? parseFloat(retailSellAds[0].price) : mediaSell;

    // -------------------------------------------------------------
    // 3. COSTO BASE Y PREVENCIÓN DE PÉRDIDAS (SIEMPRE VENDER MÁS CARO)
    // -------------------------------------------------------------
    // Costo base real de adquisición (o el precio de compra popular actual si no hay compras)
    const costBasis = getRecentPurchaseCostBasis(suggestedBuyPrice);
    
    // Piso mínimo de seguridad: Al menos +0.04 BOB por encima de lo que te costó
    const minSafeSellPrice = parseFloat((costBasis + 0.04).toFixed(2));

    // Precio de venta sugerido: Competir en la punta de los vendedores pero con margen seguro
    let suggestedSellPrice = bestSellInMarket > 0 ? bestSellInMarket : mediaSell;
    let sellReason = 'Mejor precio competitivo de venta';

    // Si el mejor precio del mercado de venta cae por debajo de tu piso seguro, proteger con el piso
    if (suggestedSellPrice < minSafeSellPrice) {
        suggestedSellPrice = minSafeSellPrice;
        sellReason = 'Piso mínimo de seguridad (+0.04 BOB)';
    } else if (suggestedSellPrice - suggestedBuyPrice < 0.04) {
        suggestedSellPrice = parseFloat((suggestedBuyPrice + 0.04).toFixed(2));
        sellReason = 'Garantía de margen estricto (+0.04 BOB)';
    }

    // Margen neto real proyectado (Vender Caro - Costo Base)
    const referenceCost = costBasis > 0 ? costBasis : suggestedBuyPrice;
    const netMarginBob = parseFloat((suggestedSellPrice - referenceCost).toFixed(3));
    const marginPercent = parseFloat(((netMarginBob / referenceCost) * 100).toFixed(2));

    return {
        // Compra Barata
        suggestedBuyPrice: suggestedBuyPrice.toFixed(2),
        popularBuyCount: maxBuyFreq,
        mediaBuy: mediaBuy.toFixed(2),
        bestBuyerPrice: bestBuyerPrice.toFixed(2),
        minOrderLimitBob: minOrderLimitBob.toFixed(2),
        
        // Venta Cara
        costBasis: costBasis.toFixed(2),
        minSafeSellPrice: minSafeSellPrice.toFixed(2),
        mediaSell: mediaSell.toFixed(2),
        bestSellInMarket: bestSellInMarket.toFixed(2),
        suggestedSellPrice: suggestedSellPrice.toFixed(2),
        
        // Margen Real Positivo
        netMarginBob: netMarginBob.toFixed(2),
        marginPercent: marginPercent.toFixed(2),
        sellReason: sellReason,

        // Frecuencias
        buyPriceFrequency,
        sellPriceFrequency
    };
}

module.exports = {
    getRecentPurchaseCostBasis,
    calculateBybitStrategicRecommendations
};
