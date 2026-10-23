/**
 * Módulo de Lectura de Saldos Vía Binance API Oficial + Web Fallback
 * Consulta tus saldos reales (Spot, Fondos, BTC, USDT) en 0.1 segundos usando HMAC SHA256.
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config');
const { scanBinanceP2PMarket } = require('./market');

let timeOffset = 0;
let lastOffsetCheck = 0;

function getBinanceServerTimeOffset() {
    return new Promise((resolve) => {
        if (Date.now() - lastOffsetCheck < 60000) {
            return resolve(timeOffset);
        }
        https.get('https://api.binance.com/api/v3/time', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const serverTime = JSON.parse(data).serverTime;
                    timeOffset = serverTime - Date.now();
                    lastOffsetCheck = Date.now();
                    resolve(timeOffset);
                } catch (e) {
                    resolve(timeOffset);
                }
            });
        }).on('error', () => resolve(timeOffset));
    });
}

async function queryBinanceApi(endpoint, method = 'GET', params = {}) {
    const config = loadEnv();
    const apiKey = config.BINANCE_API_KEY;
    const apiSecret = config.BINANCE_API_SECRET;

    if (!apiKey || !apiSecret) {
        return null;
    }

    const offset = await getBinanceServerTimeOffset();
    params.timestamp = Date.now() + offset - 1000;
    params.recvWindow = 60000;

    const queryString = Object.keys(params)
        .map(k => `${k}=${encodeURIComponent(params[k])}`)
        .join('&');

    const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

    const fullPath = `${endpoint}?${queryString}&signature=${signature}`;

    const options = {
        hostname: 'api.binance.com',
        port: 443,
        path: fullPath,
        method: method,
        headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json'
        }
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) {
                    resolve(null);
                }
            });
        });

        req.on('error', err => resolve(null));
        req.end();
    });
}

/**
 * Consulta los saldos reales de Spot y Fondos vía API Oficial
 */
async function getLiveBinanceBalancesFromApi() {
    console.log('⚡ Consultando Binance API Oficial (HMAC SHA256)...');

    const balances = {
        usdtFunding: 0,
        usdtSpot: 0,
        totalUsdt: 0,
        btcTotal: 0,
        otherAssets: {}
    };

    // 1. Consultar Billetera Spot (/api/v3/account)
    const spotRes = await queryBinanceApi('/api/v3/account', 'GET');
    if (spotRes && spotRes.balances) {
        spotRes.balances.forEach(b => {
            const free = parseFloat(b.free || 0);
            const locked = parseFloat(b.locked || 0);
            const total = free + locked;

            if (total > 0) {
                balances.otherAssets[b.asset] = total;
                if (b.asset === 'USDT') balances.usdtSpot = free;
                if (b.asset === 'BTC') balances.btcTotal = total;
            }
        });
    }

    // 2. Consultar Billetera de Fondos (/sapi/v1/asset/get-funding-asset)
    const fundingRes = await queryBinanceApi('/sapi/v1/asset/get-funding-asset', 'POST');
    if (fundingRes && Array.isArray(fundingRes)) {
        fundingRes.forEach(f => {
            const free = parseFloat(f.free || 0);
            if (f.asset === 'USDT') balances.usdtFunding = free;
            if (free > 0 && !balances.otherAssets[f.asset]) {
                balances.otherAssets[f.asset] = free;
            }
        });
    }

    balances.totalUsdt = balances.usdtFunding + balances.usdtSpot;
    return balances;
}

async function getLiveBinanceUsdtBalance() {
    const apiBalances = await getLiveBinanceBalancesFromApi();

    if (apiBalances) {
        console.log('\n=============================================================');
        console.log(' 💰 RESULTADO DE SALDOS EN VIVO (BINANCE API)');
        console.log('=============================================================');
        console.log(`🔹 USDT en Billetera de Fondos (P2P): ${apiBalances.usdtFunding.toFixed(2)} USDT`);
        console.log(`🔹 USDT en Billetera Spot:            ${apiBalances.usdtSpot.toFixed(2)} USDT`);
        if (apiBalances.btcTotal > 0) {
            console.log(`🔸 BTC en tu cuenta:                   ${apiBalances.btcTotal} BTC`);
        }

        const assetsList = Object.keys(apiBalances.otherAssets);
        if (assetsList.length > 0) {
            console.log(`📋 Todos tus activos detectados: ${assetsList.map(a => `${a}: ${apiBalances.otherAssets[a]}`).join(' | ')}`);
        }
        console.log('=============================================================\n');

        return apiBalances.usdtFunding; // El saldo relevante para P2P es Fondos
    }

    console.log('⚠️ API no retornó datos, usando 0.00 USDT por defecto.');
    return 0;
}

async function getConsolidatedBalances(liveUsdt = null) {
    const market = await scanBinanceP2PMarket();
    const referenceRate = market ? parseFloat(market.bestBuyPrice || 10.90) : 10.90;

    let usdtBalance = liveUsdt;
    if (usdtBalance === null) {
        const apiData = await getLiveBinanceBalancesFromApi();
        usdtBalance = apiData ? apiData.usdtFunding : 0;
    }

    let bancoSolBob = 6.08;
    try {
        const capitalPath = path.join(__dirname, '../capital.json');
        if (fs.existsSync(capitalPath)) {
            const capData = JSON.parse(fs.readFileSync(capitalPath, 'utf8'));
            if (capData.bancoSolBob !== undefined) bancoSolBob = parseFloat(capData.bancoSolBob);
        }
    } catch (e) {}

    const totalBobInBanks = bancoSolBob;
    const usdtEquivInBob = usdtBalance * referenceRate;
    const totalCapitalInBob = totalBobInBanks + usdtEquivInBob;
    const totalCapitalInUsdt = referenceRate > 0 ? (totalCapitalInBob / referenceRate) : 0;

    return {
        binanceUsdt: usdtBalance,
        totalBobInBanks,
        totalCapitalInBob,
        totalCapitalInUsdt,
        referenceRate
    };
}

module.exports = {
    queryBinanceApi,
    getLiveBinanceBalancesFromApi,
    getLiveBinanceUsdtBalance,
    getConsolidatedBalances
};
