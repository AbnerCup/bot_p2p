/**
 * Módulo de Lectura de Saldos Binance API — versión multi-wallet, con errores explícitos.
 *
 * Lee TODAS las wallets donde puede estar tu USDT:
 *   - SPOT (/api/v3/account) — incluye free + locked
 *   - FUNDING (/sapi/v1/asset/get-funding-asset) — la que usa P2P
 *   - EARN flexible (/sapi/v1/simple-earn/flexible/position)
 *   - EARN locked (/sapi/v1/simple-earn/locked/position)
 *   - MARGIN cross (/sapi/v1/margin/account) — opcional
 *
 * Diferencias vs versión anterior:
 *   - NO devuelve null/0 silenciosamente ante error de API. Lanza excepción con contexto.
 *   - Agrega Earn Flexible, Earn Locked y Margin que antes se ignoraban.
 *   - Incluye `locked` en Spot (antes solo `free`).
 *   - `getLiveBinanceUsdtBalance` ahora devuelve TOTAL, no solo Funding.
 *   - Imprime desglose por wallet.
 */

const crypto = require('crypto');
const https = require('https');
const { loadEnv } = require('../config');

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

/**
 * Consulta firmada contra Binance. Lanza error con contexto en caso de fallo.
 */
async function queryBinanceApi(endpoint, method = 'GET', params = {}) {
    const config = loadEnv();
    const apiKey = config.BINANCE_API_KEY;
    const apiSecret = config.BINANCE_API_SECRET;

    if (!apiKey || !apiSecret || apiKey.includes('tu_binance')) {
        throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET no configuradas en .env');
    }

    const offset = await getBinanceServerTimeOffset();
    params.timestamp = Date.now() + offset - 1000;
    params.recvWindow = 60000;

    const queryString = Object.keys(params)
        .map(k => `${k}=${encodeURIComponent(params[k])}`)
        .join('&');

    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
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

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, json });
                } catch (e) {
                    reject(new Error(`Respuesta no es JSON (status ${res.statusCode}): ${data.slice(0, 200)}`));
                }
            });
        });

        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error(`Timeout 15s al consultar ${endpoint}`));
        });

        req.on('error', err => reject(new Error(`Error de red en ${endpoint}: ${err.message}`)));
        req.end();
    });
}

async function readSpotUsdt() {
    try {
        const { status, json } = await queryBinanceApi('/api/v3/account', 'GET');
        if (status !== 200 || !json || !json.balances) {
            return { usdt: 0, available: false, note: `error status=${status} ${json?.msg || ''}` };
        }
        const u = json.balances.find(b => b.asset === 'USDT');
        if (!u) return { usdt: 0, available: true };
        const total = parseFloat(u.free || 0) + parseFloat(u.locked || 0);
        return { usdt: isNaN(total) ? 0 : total, available: true };
    } catch (e) {
        return { usdt: 0, available: false, note: e.message };
    }
}

async function readFundingUsdt() {
    try {
        const { status, json } = await queryBinanceApi('/sapi/v1/asset/get-funding-asset', 'POST', { asset: 'USDT' });
        if (status !== 200) {
            return { usdt: 0, available: false, note: `error status=${status} ${json?.msg || ''}` };
        }
        if (!Array.isArray(json)) {
            return { usdt: 0, available: true, note: 'funding vacío' };
        }
        const u = json.find(f => f.asset === 'USDT');
        if (!u) return { usdt: 0, available: true };
        const total = parseFloat(u.free || 0) + parseFloat(u.locked || 0) + parseFloat(u.freeze || 0) + parseFloat(u.withdrawing || 0);
        return { usdt: isNaN(total) ? 0 : total, available: true };
    } catch (e) {
        return { usdt: 0, available: false, note: e.message };
    }
}

async function readEarnFlexibleUsdt() {
    try {
        const { status, json } = await queryBinanceApi('/sapi/v1/simple-earn/flexible/position', 'GET', { asset: 'USDT' });
        if (status !== 200) {
            return { usdt: 0, available: false, note: `error status=${status} ${json?.msg || ''}` };
        }
        const rows = json?.rows || [];
        let total = 0;
        for (const r of rows) {
            if (r.asset === 'USDT') total += parseFloat(r.totalAmount || 0);
        }
        return { usdt: isNaN(total) ? 0 : total, available: true };
    } catch (e) {
        return { usdt: 0, available: false, note: e.message };
    }
}

async function readEarnLockedUsdt() {
    try {
        const { status, json } = await queryBinanceApi('/sapi/v1/simple-earn/locked/position', 'GET', { asset: 'USDT' });
        if (status !== 200) {
            return { usdt: 0, available: false, note: `error status=${status} ${json?.msg || ''}` };
        }
        const rows = json?.rows || [];
        let total = 0;
        for (const r of rows) {
            if (r.asset === 'USDT') total += parseFloat(r.amount || 0);
        }
        return { usdt: isNaN(total) ? 0 : total, available: true };
    } catch (e) {
        return { usdt: 0, available: false, note: e.message };
    }
}

async function readMarginUsdt() {
    try {
        const { status, json } = await queryBinanceApi('/sapi/v1/margin/account', 'GET');
        if (status !== 200) {
            // Si no tienes margin habilitado, Binance devuelve error — eso es OK, lo marcamos no-disponible sin alarmar
            return { usdt: 0, available: false, note: 'margin no habilitada o sin permiso' };
        }
        const assets = json?.userAssets || [];
        const u = assets.find(a => a.asset === 'USDT');
        if (!u) return { usdt: 0, available: true };
        const net = parseFloat(u.netAsset || 0);
        return { usdt: isNaN(net) ? 0 : net, available: true };
    } catch (e) {
        return { usdt: 0, available: false, note: e.message };
    }
}

/**
 * Consulta TODOS los saldos USDT en Binance y los suma.
 * Lanza error si NINGUNA wallet respondió correctamente.
 */
async function getLiveBinanceBalancesFromApi(opts = {}) {
    const verbose = opts.verbose !== false;
    if (verbose) console.log('⚡ Consultando Binance API (todas las wallets)...');

    const [spotR, fundingR, earnFlexR, earnLockedR, marginR] = await Promise.allSettled([
        readSpotUsdt(),
        readFundingUsdt(),
        readEarnFlexibleUsdt(),
        readEarnLockedUsdt(),
        readMarginUsdt()
    ]);

    const wallets = {
        spot: spotR.status === 'fulfilled' ? spotR.value : { usdt: 0, available: false, note: spotR.reason?.message },
        funding: fundingR.status === 'fulfilled' ? fundingR.value : { usdt: 0, available: false, note: fundingR.reason?.message },
        earnFlex: earnFlexR.status === 'fulfilled' ? earnFlexR.value : { usdt: 0, available: false, note: earnFlexR.reason?.message },
        earnLocked: earnLockedR.status === 'fulfilled' ? earnLockedR.value : { usdt: 0, available: false, note: earnLockedR.reason?.message },
        margin: marginR.status === 'fulfilled' ? marginR.value : { usdt: 0, available: false, note: marginR.reason?.message }
    };

    const totalUsdt = wallets.spot.usdt + wallets.funding.usdt + wallets.earnFlex.usdt + wallets.earnLocked.usdt + wallets.margin.usdt;

    // ¿Al menos Spot o Funding respondieron? Esas son las críticas.
    const criticalAvailable = wallets.spot.available || wallets.funding.available;

    if (verbose) {
        console.log('   📊 Desglose por wallet:');
        console.log(`      • SPOT:              ${wallets.spot.available ? wallets.spot.usdt.toFixed(2) + ' USDT' : '❌ ' + wallets.spot.note}`);
        console.log(`      • FUNDING (P2P):     ${wallets.funding.available ? wallets.funding.usdt.toFixed(2) + ' USDT' : '❌ ' + wallets.funding.note}`);
        console.log(`      • EARN Flexible:     ${wallets.earnFlex.available ? wallets.earnFlex.usdt.toFixed(2) + ' USDT' : '⚪ ' + wallets.earnFlex.note}`);
        console.log(`      • EARN Locked:       ${wallets.earnLocked.available ? wallets.earnLocked.usdt.toFixed(2) + ' USDT' : '⚪ ' + wallets.earnLocked.note}`);
        console.log(`      • MARGIN Cross:      ${wallets.margin.available ? wallets.margin.usdt.toFixed(2) + ' USDT' : '⚪ ' + wallets.margin.note}`);
        console.log(`      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`      TOTAL USDT en Binance: ${totalUsdt.toFixed(2)} USDT`);
    }

    if (!criticalAvailable) {
        throw new Error(`Ni Spot ni Funding respondieron. Errores: SPOT="${wallets.spot.note}", FUNDING="${wallets.funding.note}"`);
    }

    return {
        totalUsdt,
        usdtSpot: wallets.spot.usdt,
        usdtFunding: wallets.funding.usdt,
        usdtEarnFlex: wallets.earnFlex.usdt,
        usdtEarnLocked: wallets.earnLocked.usdt,
        usdtMargin: wallets.margin.usdt,
        wallets,
        trusted: criticalAvailable
    };
}

/**
 * Devuelve el total USDT (antes devolvía solo Funding — bug).
 */
async function getLiveBinanceUsdtBalance() {
    const bal = await getLiveBinanceBalancesFromApi({ verbose: false });
    return bal.totalUsdt;
}

module.exports = {
    queryBinanceApi,
    getLiveBinanceBalancesFromApi,
    getLiveBinanceUsdtBalance
};
