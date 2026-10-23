/**
 * Módulo Escáner de Mercado Bybit P2P (BOB/USDT)
 * Consulta las mejores ofertas de Compra y Venta para calcular Spreads y Márgenes de Ganancia.
 */

const https = require('https');

function fetchBybitP2P({ side = '1', tokenId = 'USDT', currencyId = 'BOB', size = '5', page = '1' }) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            tokenId: tokenId,
            currencyId: currencyId,
            side: String(side), // '1': Vendedores de USDT (Donde nosotros compramos USDT), '0': Compradores de USDT (Donde nosotros vendemos USDT)
            page: String(page),
            size: String(size),
            authMaker: false,
            canTrade: false
        });

        const options = {
            hostname: 'api2.bybit.com',
            port: 443,
            path: '/fiat/otc/item/online',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json && json.ret_code === 0 && json.result && Array.isArray(json.result.items)) {
                        resolve(json.result.items);
                    } else {
                        resolve([]);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
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
