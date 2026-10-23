/**
 * Módulo Escáner de Mercado Binance P2P (BOB/USDT)
 * Consulta las mejores ofertas de Compra y Venta para calcular Spreads y Márgenes de Ganancia.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BINANCE_CACHE_FILE = path.join(__dirname, '../binance_cache.json');

// Caché en memoria y disco para mitigar bloqueos temporales 429 de CloudFront
let lastBinanceCache = {
    BUY: [],
    SELL: [],
    lastUpdated: 0
};

try {
    if (fs.existsSync(BINANCE_CACHE_FILE)) {
        const diskCache = JSON.parse(fs.readFileSync(BINANCE_CACHE_FILE, 'utf8'));
        if (diskCache && typeof diskCache === 'object') {
            lastBinanceCache = Object.assign(lastBinanceCache, diskCache);
        }
    }
} catch (e) {}

function saveBinanceCache() {
    try {
        fs.writeFileSync(BINANCE_CACHE_FILE, JSON.stringify(lastBinanceCache, null, 2), 'utf8');
    } catch (e) {}
}

function fetchBinanceP2P({ tradeType = 'BUY', asset = 'USDT', fiat = 'BOB', rows = 5 }) {
    const hosts = ['www.binance.com', 'p2p.binance.com'];

    function attempt(hostIndex = 0) {
        return new Promise((resolve) => {
            const host = hosts[hostIndex] || 'www.binance.com';
            const postData = JSON.stringify({
                asset: asset,
                fiat: fiat,
                merchantCheck: false,
                page: 1,
                rows: rows,
                tradeType: tradeType // 'BUY' o 'SELL'
            });

            const options = {
                hostname: host,
                port: 443,
                path: '/bapi/c2c/v2/friendly/c2c/adv/search',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Origin': 'https://p2p.binance.com',
                    'Referer': 'https://p2p.binance.com/',
                    'clienttype': 'web'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    // Si CloudFront devuelve 429 (Too Many Requests) o respuesta vacía, intentar host alternativo
                    if (res.statusCode === 429 || !data || !data.trim()) {
                        if (hostIndex + 1 < hosts.length) {
                            return attempt(hostIndex + 1).then(resolve);
                        }
                        // Si se agotaron los hosts, devolver datos en caché si existen
                        if (lastBinanceCache[tradeType] && lastBinanceCache[tradeType].length > 0) {
                            return resolve(lastBinanceCache[tradeType]);
                        }
                        return resolve([]);
                    }

                    try {
                        const json = JSON.parse(data);
                        if (json && Array.isArray(json.data) && json.data.length > 0) {
                            lastBinanceCache[tradeType] = json.data;
                            lastBinanceCache.lastUpdated = Date.now();
                            saveBinanceCache();
                            return resolve(json.data);
                        }
                        // Si la API devuelve un código de error interno
                        if (lastBinanceCache[tradeType] && lastBinanceCache[tradeType].length > 0) {
                            return resolve(lastBinanceCache[tradeType]);
                        }
                        resolve([]);
                    } catch (e) {
                        if (hostIndex + 1 < hosts.length) {
                            return attempt(hostIndex + 1).then(resolve);
                        }
                        if (lastBinanceCache[tradeType] && lastBinanceCache[tradeType].length > 0) {
                            return resolve(lastBinanceCache[tradeType]);
                        }
                        resolve([]);
                    }
                });
            });

            req.on('error', () => {
                if (hostIndex + 1 < hosts.length) {
                    return attempt(hostIndex + 1).then(resolve);
                }
                if (lastBinanceCache[tradeType] && lastBinanceCache[tradeType].length > 0) {
                    return resolve(lastBinanceCache[tradeType]);
                }
                resolve([]);
            });

            req.setTimeout(6000, () => {
                req.destroy();
                if (hostIndex + 1 < hosts.length) {
                    return attempt(hostIndex + 1).then(resolve);
                }
                if (lastBinanceCache[tradeType] && lastBinanceCache[tradeType].length > 0) {
                    return resolve(lastBinanceCache[tradeType]);
                }
                resolve([]);
            });

            req.write(postData);
            req.end();
        });
    }

    return attempt(0);
}

/**
 * Escanea tanto la punta de compra como de venta y calcula el Spread
 */
async function scanBinanceP2PMarket() {
    console.log('--- ESCANEANDO MERCADO BINANCE P2P (BOB/USDT) ---');

    try {
        // Perspectiva MAKER:
        // - tradeType 'SELL': Lista de compradores de USDT (donde nosotros COMPRAMOS BARATO ~10.91 BOB)
        // - tradeType 'BUY':  Lista de vendedores de USDT (donde nosotros VENDEMOS CARO ~11.04 BOB)
        const [competitorSellers, competitorBuyers] = await Promise.all([
            fetchBinanceP2P({ tradeType: 'BUY', rows: 5 }),  // Vendedores (Precios altos: donde tú vendes caro)
            fetchBinanceP2P({ tradeType: 'SELL', rows: 5 }) // Compradores (Precios bajos: donde tú compras barato)
        ]);

        // Filtrar anuncios extremos/anormales (como anuncios de 12.00 con mínimos de 100,000 Bs)
        const normalBuyers = competitorBuyers.filter(b => {
            const p = parseFloat(b.adv.price);
            return p >= 9.00 && p <= 11.30;
        });
        const normalSellers = competitorSellers.filter(s => {
            const p = parseFloat(s.adv.price);
            return p >= 10.00 && p <= 12.00;
        });

        const bestBuyMakerPrice = normalBuyers[0]?.adv ? parseFloat(normalBuyers[0].adv.price) : (competitorBuyers[0]?.adv ? parseFloat(competitorBuyers[0].adv.price) : 0);
        const bestSellMakerPrice = normalSellers[0]?.adv ? parseFloat(normalSellers[0].adv.price) : (competitorSellers[0]?.adv ? parseFloat(competitorSellers[0].adv.price) : 0);

        const spread = (bestSellMakerPrice > 0 && bestBuyMakerPrice > 0) ? (bestSellMakerPrice - bestBuyMakerPrice).toFixed(3) : 0;
        const marginPercent = bestBuyMakerPrice > 0 ? ((spread / bestBuyMakerPrice) * 100).toFixed(2) : 0;

        console.log(`\n📊 ANÁLISIS DE MERCADO (PERSPECTIVA MAKER):`);
        console.log(`🟢 Precio para COMPRAR USDT BARATO: ${bestBuyMakerPrice} BOB`);
        console.log(`🔴 Precio para VENDER USDT CARO:    ${bestSellMakerPrice} BOB`);
        console.log(`📈 Margen / Spread Neto:          +${spread} BOB por USDT (${marginPercent}%)`);

        console.log(`\n🟢 TOP COMPRADORES (Competencia para comprar barato):`);
        competitorBuyers.slice(0, 5).forEach((item, index) => {
            const adv = item.adv;
            const merchant = item.advertiser;
            const payments = (adv.tradeMethods || []).map(m => m.tradeMethodName).join(', ');
            console.log(`[#${index + 1}] ${merchant.nickName} | Compra a: ${adv.price} BOB | Min/Max: ${adv.minSingleTransAmount}-${adv.maxSingleTransAmount} BOB | Pagos: ${payments}`);
        });

        console.log(`\n🔴 TOP VENDEDORES (Competencia para vender caro):`);
        competitorSellers.slice(0, 5).forEach((item, index) => {
            const adv = item.adv;
            const merchant = item.advertiser;
            const payments = (adv.tradeMethods || []).map(m => m.tradeMethodName).join(', ');
            console.log(`[#${index + 1}] ${merchant.nickName} | Vende a: ${adv.price} BOB | Min/Max: ${adv.minSingleTransAmount}-${adv.maxSingleTransAmount} BOB | Pagos: ${payments}`);
        });

        return {
            bestBuyPrice: bestBuyMakerPrice,
            bestSellPrice: bestSellMakerPrice,
            spread,
            marginPercent,
            buyAds: competitorBuyers,
            sellAds: competitorSellers
        };
    } catch (error) {
        console.error('Error al escanear el mercado de Binance:', error.message);
        return null;
    }
}

if (require.main === module) {
    scanBinanceP2PMarket();
}

module.exports = {
    fetchBinanceP2P,
    scanBinanceP2PMarket
};
