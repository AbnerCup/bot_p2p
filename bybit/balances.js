/**
 * Módulo de Lectura de Saldos Vía Bybit API v5 Oficial + Sincronización Horaria y Fallback
 * Consulta tus saldos reales (Spot, Fondos, USDT) usando HMAC SHA256.
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config');
const { scanBybitP2PMarket } = require('./market');

const CAPITAL_FILE = path.join(__dirname, '../capital.json');

let cachedServerOffset = null;
let lastOffsetCheck = 0;

/**
 * Obtiene la hora oficial del servidor de Bybit para corregir desfase de reloj local
 */
function getBybitServerTime() {
    return new Promise((resolve) => {
        // Cachear el offset por 5 minutos
        if (cachedServerOffset !== null && (Date.now() - lastOffsetCheck) < 300000) {
            return resolve(cachedServerOffset);
        }

        https.get('https://api.bybit.com/v5/market/time', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const serverTime = parseInt(json.time || (json.result && json.result.timeSecond * 1000) || Date.now());
                    cachedServerOffset = serverTime - Date.now();
                    lastOffsetCheck = Date.now();
                    resolve(cachedServerOffset);
                } catch (e) {
                    resolve(0);
                }
            });
        }).on('error', () => resolve(0));
    });
}

/**
 * Ejecuta una consulta firmada por HMAC SHA256 contra Bybit v5
 */
async function queryBybitApi(endpoint, method = 'GET', params = {}) {
    const config = loadEnv();
    const apiKey = config.BYBIT_API_KEY;
    const apiSecret = config.BYBIT_API_SECRET;

    if (!apiKey || !apiSecret || apiKey.includes('tu_bybit')) {
        return null;
    }

    const timeOffset = await getBybitServerTime();
    const timestamp = (Date.now() + timeOffset).toString();
    const recvWindow = '20000';

    const queryString = Object.keys(params)
        .map(k => `${k}=${encodeURIComponent(params[k])}`)
        .join('&');

    const signPayload = timestamp + apiKey + recvWindow + queryString;
    const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(signPayload)
        .digest('hex');

    const fullPath = queryString ? `${endpoint}?${queryString}` : endpoint;

    return new Promise((resolve) => {
        const options = {
            hostname: 'api.bybit.com',
            port: 443,
            path: fullPath,
            method: method,
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'X-BAPI-SIGN': signature,
                'Content-Type': 'application/json'
            }
        };

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
 * Consulta los saldos reales de Bybit vía API Oficial v5
 */
async function getLiveBybitBalancesFromApi() {
    const balances = {
        usdtFunding: 0,
        usdtSpot: 0,
        totalUsdt: 0,
        hasPermission: true
    };

    // 1. Consultar Billetera Unificada / Spot (UNIFIED)
    const unifiedRes = await queryBybitApi('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
    if (unifiedRes) {
        if (unifiedRes.retCode === 10005) {
            balances.hasPermission = false;
        } else if (unifiedRes.retCode === 0 && unifiedRes.result && Array.isArray(unifiedRes.result.list)) {
            unifiedRes.result.list.forEach(acc => {
                if (Array.isArray(acc.coin)) {
                    acc.coin.forEach(c => {
                        const walletBalance = parseFloat(c.walletBalance || 0);
                        if (c.coin === 'USDT') balances.usdtSpot = walletBalance;
                    });
                }
            });
        }
    }

    // 2. Consultar Billetera de Fondos (FUND)
    const fundRes = await queryBybitApi('/v5/asset/transfer/query-account-coin-balance', 'GET', { accountType: 'FUND', coin: 'USDT' });
    if (fundRes) {
        if (fundRes.retCode === 10005) {
            balances.hasPermission = false;
        } else if (fundRes.retCode === 0 && fundRes.result && fundRes.result.balance) {
            balances.usdtFunding = parseFloat(fundRes.result.balance.walletBalance || fundRes.result.balance.transferableBalance || 0);
        }
    }

    balances.totalUsdt = balances.usdtFunding + balances.usdtSpot;

    // Si la API no tiene permiso "Wallet", leer capital.json como fallback
    if (!balances.hasPermission || balances.totalUsdt === 0) {
        if (fs.existsSync(CAPITAL_FILE)) {
            try {
                const cap = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
                if (typeof cap.bybitUsdt === 'number') {
                    balances.totalUsdt = cap.bybitUsdt;
                    balances.usdtFunding = cap.bybitUsdt;
                }
            } catch (e) {}
        }
    }

    return balances;
}

async function getLiveBybitUsdtBalance() {
    const apiBalances = await getLiveBybitBalancesFromApi();

    if (apiBalances) {
        if (!apiBalances.hasPermission) {
            // Nota de diagnóstico amigable
        }
        return apiBalances.usdtFunding > 0 ? apiBalances.usdtFunding : apiBalances.totalUsdt;
    }

    return 0;
}

async function getConsolidatedBalances(liveUsdt = null) {
    const market = await scanBybitP2PMarket();
    const referenceRate = market ? parseFloat(market.bestBuyPrice || 11.88) : 11.88;

    let usdtBalance = liveUsdt;
    if (usdtBalance === null) {
        usdtBalance = await getLiveBybitUsdtBalance();
    }

    let bancoSolBob = 4209.75;
    if (fs.existsSync(CAPITAL_FILE)) {
        try {
            const cap = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
            if (typeof cap.bancoSolBob === 'number') bancoSolBob = cap.bancoSolBob;
        } catch (e) {}
    }

    const totalBobInBanks = bancoSolBob;
    const usdtEquivInBob = usdtBalance * referenceRate;
    const totalCapitalInBob = totalBobInBanks + usdtEquivInBob;
    const totalCapitalInUsdt = referenceRate > 0 ? (totalCapitalInBob / referenceRate) : 0;

    return {
        bybitUsdt: usdtBalance,
        totalBobInBanks,
        totalCapitalInBob,
        totalCapitalInUsdt,
        referenceRate
    };
}

module.exports = {
    getBybitServerTime,
    queryBybitApi,
    getLiveBybitBalancesFromApi,
    getLiveBybitUsdtBalance,
    getConsolidatedBalances
};
