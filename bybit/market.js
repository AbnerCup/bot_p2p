/**
 * Módulo Escáner de Mercado Bybit P2P (BOB/USDT)
 * Consulta las mejores ofertas de Compra y Venta para calcular Spreads y Márgenes de Ganancia.
 *
 * ROBUSTEZ (fix B7): a diferencia de la versión anterior, esta implementación:
 *   - Cachea las últimas respuestas válidas en disco (bybit_cache.json) para que si Bybit
 *     cae con 429/503/timeout, el radar siga mostrando datos recientes en vez de [].
 *   - Prueba host fallback: api2.bybit.com → api.bybit.com.
 *   - Nunca rechaza (reject) la promesa: siempre resuelve con [] o con cache. Esto evita
 *     que un pico de error de Bybit mate el ciclo del radar.
 *   - Timeout explícito de 8s por request (antes no tenía, el request podía colgarse).
 *   - Log de 429/5xx una sola vez cada 60s para no spamear la consola del radar.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BYBIT_CACHE_FILE = path.join(__dirname, '../bybit_cache.json');

// Caché en memoria + disco (una entrada por combinación side+currency+token).
// Clave: `${side}_${currency}_${token}` → { items: [...], lastUpdated: timestamp }
let bybitCache = { entries: {} };

try {
    if (fs.existsSync(BYBIT_CACHE_FILE)) {
        const diskCache = JSON.parse(fs.readFileSync(BYBIT_CACHE_FILE, 'utf8'));
        if (diskCache && typeof diskCache === 'object') {
            bybitCache = Object.assign(bybitCache, diskCache);
            if (!bybitCache.entries) bybitCache.entries = {};
        }
    }
} catch (e) {}

function saveBybitCache() {
    try {
        fs.writeFileSync(BYBIT_CACHE_FILE, JSON.stringify(bybitCache, null, 2), 'utf8');
    } catch (e) {}
}

// Debounce de warnings para no spamear la consola del radar
let lastWarnTime = 0;
function warnOnce(message) {
    const now = Date.now();
    if (now - lastWarnTime > 60000) {
        console.error('[bybit/market]', message);
        lastWarnTime = now;
    }
}

function fetchBybitP2P({ side = '1', tokenId = 'USDT', currencyId = 'BOB', size = '5', page = '1' }) {
    const cacheKey = `${side}_${currencyId}_${tokenId}`;
    const hosts = ['api2.bybit.com', 'api.bybit.com'];

    function attempt(hostIndex = 0) {
        return new Promise((resolve) => {
            const host = hosts[hostIndex] || 'api2.bybit.com';
            const postData = JSON.stringify({
                tokenId: tokenId,
                currencyId: currencyId,
                side: String(side),
                page: String(page),
                size: String(size),
                authMaker: false,
                canTrade: false
            });

            const options = {
                hostname: host,
                port: 443,
                path: '/fiat/otc/item/online',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                    'Origin': 'https://www.bybit.com',
                    'Referer': 'https://www.bybit.com/'
                }
            };

            const fallbackToCacheOrEmpty = (reason) => {
                const cached = bybitCache.entries[cacheKey];
                if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
                    const ageSec = Math.floor((Date.now() - cached.lastUpdated) / 1000);
                    warnOnce(`${reason}. Usando cache (${ageSec}s de antigüedad, ${cached.items.length} items).`);
                    return resolve(cached.items);
                }
                warnOnce(`${reason}. Sin cache previo → devolviendo [].`);
                resolve([]);
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    // 429 (rate limit) o 5xx → probar host alterno, si no cache
                    if (res.statusCode === 429 || res.statusCode >= 500) {
                        if (hostIndex + 1 < hosts.length) {
                            return attempt(hostIndex + 1).then(resolve);
                        }
                        return fallbackToCacheOrEmpty(`Bybit respondió ${res.statusCode}`);
                    }

                    // 403 geo-block u otro error de cliente → ir directo a cache (otro host no ayuda)
                    if (res.statusCode === 403 || (res.statusCode >= 400 && res.statusCode < 500)) {
                        return fallbackToCacheOrEmpty(`Bybit respondió ${res.statusCode} (${data.slice(0, 80)})`);
                    }

                    if (!data || !data.trim()) {
                        if (hostIndex + 1 < hosts.length) {
                            return attempt(hostIndex + 1).then(resolve);
                        }
                        return fallbackToCacheOrEmpty('respuesta vacía');
                    }

                    try {
                        const json = JSON.parse(data);
                        if (json && json.ret_code === 0 && json.result && Array.isArray(json.result.items)) {
                            // Guardar en caché solo si trajo items reales
                            if (json.result.items.length > 0) {
                                bybitCache.entries[cacheKey] = {
                                    items: json.result.items,
                                    lastUpdated: Date.now()
                                };
                                saveBybitCache();
                            }
                            return resolve(json.result.items);
                        }
                        // Respuesta válida pero sin items (ret_code != 0, o result vacío)
                        return resolve([]);
                    } catch (e) {
                        if (hostIndex + 1 < hosts.length) {
                            return attempt(hostIndex + 1).then(resolve);
                        }
                        return fallbackToCacheOrEmpty(`JSON parse falló: ${e.message}`);
                    }
                });
            });

            req.setTimeout(8000, () => {
                req.destroy();
                if (hostIndex + 1 < hosts.length) {
                    return attempt(hostIndex + 1).then(resolve);
                }
                return fallbackToCacheOrEmpty('timeout 8s');
            });

            req.on('error', (err) => {
                if (hostIndex + 1 < hosts.length) {
                    return attempt(hostIndex + 1).then(resolve);
                }
                return fallbackToCacheOrEmpty(`error red: ${err.message}`);
            });

            req.write(postData);
            req.end();
        });
    }

    return attempt(0);
}

/**
 * Escanea tanto la punta de compra como de venta y calcula el Spread en Bybit
 */
async function scanBybitP2PMarket() {
    console.log('--- ESCANEANDO MERCADO BYBIT P2P (BOB/USDT) ---');

    try {
        const [buyAds, sellAds] = await Promise.all([
            fetchBybitP2P({ side: '1', size: 5 }), // Ofertas para comprar USDT
            fetchBybitP2P({ side: '0', size: 5 })  // Ofertas para vender USDT
        ]);

        const bestBuy = buyAds[0];
        const bestSell = sellAds[0];

        const bestBuyPrice = bestBuy ? parseFloat(bestBuy.price) : 0;
        const bestSellPrice = bestSell ? parseFloat(bestSell.price) : 0;

        const spread = (bestSellPrice > 0 && bestBuyPrice > 0) ? (bestSellPrice - bestBuyPrice).toFixed(3) : 0;
        const marginPercent = bestBuyPrice > 0 ? ((spread / bestBuyPrice) * 100).toFixed(2) : 0;

        console.log(`\n📊 ANÁLISIS DE MERCADO (BYBIT P2P):`);
        console.log(`- Mejor Precio para COMPRAR USDT (Anuncios VENTA): ${bestBuyPrice} BOB`);
        console.log(`- Mejor Precio para VENDER USDT (Anuncios COMPRA): ${bestSellPrice} BOB`);
        console.log(`- Margen / Spread Neto: ${spread} BOB por USDT (${marginPercent}%)`);

        console.log(`\n🔴 TOP 5 VENDEDORES DE USDT (Donde tú compras USDT):`);
        buyAds.slice(0, 5).forEach((item, index) => {
            const nick = item.nickName || 'Comerciante';
            const price = item.price;
            const min = item.minAmount;
            const max = item.maxAmount;
            const payments = Array.isArray(item.payments) ? item.payments.join(', ') : '';
            console.log(`[#${index + 1}] ${nick} | Precio: ${price} BOB | Min/Max: ${min}-${max} BOB | Pagos Code: ${payments}`);
        });

        console.log(`\n🟢 TOP 5 COMPRADORES DE USDT (Donde tú vendes USDT):`);
        sellAds.slice(0, 5).forEach((item, index) => {
            const nick = item.nickName || 'Comerciante';
            const price = item.price;
            const min = item.minAmount;
            const max = item.maxAmount;
            const payments = Array.isArray(item.payments) ? item.payments.join(', ') : '';
            console.log(`[#${index + 1}] ${nick} | Precio: ${price} BOB | Min/Max: ${min}-${max} BOB | Pagos Code: ${payments}`);
        });

        return {
            bestBuyPrice,
            bestSellPrice,
            spread,
            marginPercent,
            buyAds,
            sellAds
        };
    } catch (error) {
        console.error('Error al escanear el mercado de Bybit:', error.message);
        return null;
    }
}

if (require.main === module) {
    scanBybitP2PMarket();
}

module.exports = {
    fetchBybitP2P,
    scanBybitP2PMarket
};
