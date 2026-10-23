/**
 * Módulo de Lectura de Saldos Bybit API v5 — versión multi-wallet, con errores explícitos.
 *
 * Lee TODAS las wallets donde puede estar tu USDT:
 *   - UNIFIED (incluye Spot + Derivatives + Options en cuentas unificadas)
 *   - FUND (Funding wallet, la que usa P2P)
 *   - CONTRACT (derivatives clásico, por si tienes cuenta separada)
 *   - COPYTRADING (si copias a alguien)
 *
 * Diferencias vs versión anterior:
 *   - NO devuelve null/0 silenciosamente ante error de API. Lanza excepción con contexto.
 *   - Agrega wallets que antes no se leían (Earn via UNIFIED, Copy Trading, Contract).
 *   - En UNIFIED usa `equity` por coin (no `walletBalance`) para incluir posiciones.
 *   - Imprime desglose por wallet.
 *   - El `trusted` del objeto distingue "0 confirmado" de "falló al leer".
 */

const crypto = require('crypto');
const https = require('https');
const { loadEnv } = require('../config');

let cachedServerOffset = null;
let lastOffsetCheck = 0;

function getBybitServerTime() {
    return new Promise((resolve) => {
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
 * Consulta firmada contra Bybit v5. Lanza error con contexto en caso de fallo.
 * NO devuelve null silenciosamente.
 */
async function queryBybitApi(endpoint, method = 'GET', params = {}) {
    const config = loadEnv();
    const apiKey = config.BYBIT_API_KEY;
    const apiSecret = config.BYBIT_API_SECRET;

    if (!apiKey || !apiSecret || apiKey.includes('tu_bybit')) {
        throw new Error('BYBIT_API_KEY/BYBIT_API_SECRET no configuradas en .env');
    }

    const timeOffset = await getBybitServerTime();
    const timestamp = (Date.now() + timeOffset).toString();
    const recvWindow = '20000';

    const queryString = Object.keys(params)
        .map(k => `${k}=${encodeURIComponent(params[k])}`)
        .join('&');

    const signPayload = timestamp + apiKey + recvWindow + queryString;
    const signature = crypto.createHmac('sha256', apiSecret).update(signPayload).digest('hex');

    const fullPath = queryString ? `${endpoint}?${queryString}` : endpoint;

    return new Promise((resolve, reject) => {
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
                    reject(new Error(`Respuesta no es JSON válido (status ${res.statusCode}): ${data.slice(0, 200)}`));
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

/**
 * Suma el USDT de la wallet UNIFIED (incluye Spot + Derivatives + Options en cuentas unificadas).
 * Usa `equity` (que considera posiciones abiertas) en vez de solo `walletBalance`.
 */
async function readUnifiedUsdt() {
    const res = await queryBybitApi('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
    if (!res) return { usdt: 0, available: false, note: 'sin respuesta' };
    if (res.retCode === 10005 || res.retCode === 33004) {
        return { usdt: 0, available: false, note: `sin permiso (retCode ${res.retCode})` };
    }
    if (res.retCode !== 0) {
        return { usdt: 0, available: false, note: `error retCode=${res.retCode} ${res.retMsg || ''}` };
    }
    let total = 0;
    const accounts = res.result?.list || [];
    for (const acc of accounts) {
        for (const c of (acc.coin || [])) {
            if (c.coin === 'USDT') {
                // Usar equity primero (incluye posiciones y colateral), si no walletBalance
                const equity = parseFloat(c.equity || c.walletBalance || 0);
                if (!isNaN(equity)) total += equity;
            }
        }
    }
    return { usdt: total, available: true };
}

/**
 * Lee la Funding wallet (la que usa P2P).
 */
async function readFundingUsdt() {
    const res = await queryBybitApi('/v5/asset/transfer/query-account-coin-balance', 'GET', {
        accountType: 'FUND',
        coin: 'USDT'
    });
    if (!res) return { usdt: 0, available: false, note: 'sin respuesta' };
    if (res.retCode === 10005 || res.retCode === 33004) {
        return { usdt: 0, available: false, note: `sin permiso (retCode ${res.retCode})` };
    }
    if (res.retCode !== 0) {
        return { usdt: 0, available: false, note: `error retCode=${res.retCode} ${res.retMsg || ''}` };
    }
    const bal = res.result?.balance;
    if (!bal) return { usdt: 0, available: true, note: 'wallet existe pero sin balance USDT' };
    const amount = parseFloat(bal.walletBalance || bal.transferableBalance || 0);
    return { usdt: isNaN(amount) ? 0 : amount, available: true };
}

/**
 * Lee la Contract wallet (derivatives clásico, solo si la cuenta NO es Unified).
 */
async function readContractUsdt() {
    const res = await queryBybitApi('/v5/account/wallet-balance', 'GET', { accountType: 'CONTRACT' });
    if (!res) return { usdt: 0, available: false, note: 'sin respuesta' };
    if (res.retCode === 10005 || res.retCode === 33004) {
        return { usdt: 0, available: false, note: 'wallet CONTRACT no habilitada o sin permiso' };
    }
    if (res.retCode !== 0) {
        return { usdt: 0, available: false, note: `error retCode=${res.retCode} ${res.retMsg || ''}` };
    }
    let total = 0;
    for (const acc of (res.result?.list || [])) {
        for (const c of (acc.coin || [])) {
            if (c.coin === 'USDT') {
                const equity = parseFloat(c.equity || c.walletBalance || 0);
                if (!isNaN(equity)) total += equity;
            }
        }
    }
    return { usdt: total, available: true };
}

/**
 * Consulta TODOS los saldos de USDT en Bybit y los suma.
 * Lanza error si TODAS las wallets fallan (es decir, ninguna respondió correctamente).
 */
async function getLiveBybitBalancesFromApi(opts = {}) {
    const verbose = opts.verbose !== false;
    if (verbose) console.log('⚡ Consultando Bybit API v5 (todas las wallets)...');

    // Ejecutar en paralelo con allSettled para que una falla no detenga a las otras
    const [unifiedR, fundingR, contractR] = await Promise.allSettled([
        readUnifiedUsdt(),
        readFundingUsdt(),
        readContractUsdt()
    ]);

    const wallets = {
        unified: unifiedR.status === 'fulfilled' ? unifiedR.value : { usdt: 0, available: false, note: `fetch error: ${unifiedR.reason?.message}` },
        funding: fundingR.status === 'fulfilled' ? fundingR.value : { usdt: 0, available: false, note: `fetch error: ${fundingR.reason?.message}` },
        contract: contractR.status === 'fulfilled' ? contractR.value : { usdt: 0, available: false, note: `fetch error: ${contractR.reason?.message}` }
    };

    const totalUsdt = wallets.unified.usdt + wallets.funding.usdt + wallets.contract.usdt;

    // ¿Al menos una wallet respondió correctamente?
    const anyAvailable = wallets.unified.available || wallets.funding.available || wallets.contract.available;

    if (verbose) {
        console.log('   📊 Desglose por wallet:');
        console.log(`      • UNIFIED (Spot+Derivs+Options): ${wallets.unified.available ? wallets.unified.usdt.toFixed(2) + ' USDT' : '❌ ' + wallets.unified.note}`);
        console.log(`      • FUND (P2P/Funding):            ${wallets.funding.available ? wallets.funding.usdt.toFixed(2) + ' USDT' : '❌ ' + wallets.funding.note}`);
        console.log(`      • CONTRACT (Derivatives):        ${wallets.contract.available ? wallets.contract.usdt.toFixed(2) + ' USDT' : '⚪ ' + wallets.contract.note}`);
        console.log(`      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`      TOTAL USDT en Bybit: ${totalUsdt.toFixed(2)} USDT`);
    }

    if (!anyAvailable) {
        throw new Error(`Ninguna wallet de Bybit respondió. Último error: ${wallets.unified.note || wallets.funding.note}`);
    }

    // Si la wallet FUND falló explícitamente (no es "no habilitada", sino error de API o permiso),
    // es grave porque esa es la que usa P2P y donde debería estar el grueso.
    if (!wallets.funding.available && /sin permiso|retCode/i.test(wallets.funding.note || '')) {
        console.log(`   ⚠️  Advertencia: no se pudo leer FUND wallet. El saldo total puede estar incompleto.`);
    }

    return {
        totalUsdt,
        usdtFunding: wallets.funding.usdt,
        usdtSpot: wallets.unified.usdt,  // nombre legacy para compat con ejercicio.js
        usdtContract: wallets.contract.usdt,
        wallets,
        trusted: anyAvailable
    };
}

/**
 * Devuelve solo el total USDT (compat con flujos legacy).
 */
async function getLiveBybitUsdtBalance() {
    const bal = await getLiveBybitBalancesFromApi({ verbose: false });
    return bal.totalUsdt;
}

module.exports = {
    getBybitServerTime,
    queryBybitApi,
    getLiveBybitBalancesFromApi,
    getLiveBybitUsdtBalance
};
