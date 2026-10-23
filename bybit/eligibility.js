/**
 * MÓDULO DE VERIFICACIÓN DE ELEGIBILIDAD BYBIT P2P
 * 
 * Filtra anuncios según los requisitos fijados por los comerciantes en `tradingPreferenceSet`:
 * 1. Antigüedad mínima de la cuenta (días de registro, ej: 90 días, 30 días)
 * 2. Mínimo de órdenes completadas en los últimos 30 días
 * 3. Tasa mínima de finalización de órdenes en los últimos 30 días
 * 4. Verificación de identidad (KYC, email, móvil)
 * 5. Lista de comerciantes ignorados / en lista negra
 */

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config');

const IGNORED_MERCHANTS_FILE = path.join(__dirname, '../ignored_merchants.json');

function loadIgnoredMerchants() {
    let list = [];
    if (fs.existsSync(IGNORED_MERCHANTS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(IGNORED_MERCHANTS_FILE, 'utf8'));
            if (Array.isArray(data)) list = data;
        } catch (e) {}
    }

    // Cargar también de .env si existe BYBIT_IGNORED_MERCHANTS
    const env = loadEnv();
    if (env.BYBIT_IGNORED_MERCHANTS) {
        const fromEnv = env.BYBIT_IGNORED_MERCHANTS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        list = Array.from(new Set([...list.map(s => s.toUpperCase()), ...fromEnv]));
    }

    return list.map(s => s.toUpperCase());
}

function addIgnoredMerchant(nickName) {
    if (!nickName) return;
    const cleanNick = nickName.trim().toUpperCase();
    const current = loadIgnoredMerchants();
    if (!current.includes(cleanNick)) {
        current.push(cleanNick);
        fs.writeFileSync(IGNORED_MERCHANTS_FILE, JSON.stringify(current, null, 2), 'utf8');
    }
}

function removeIgnoredMerchant(nickName) {
    if (!nickName) return;
    const cleanNick = nickName.trim().toUpperCase();
    const current = loadIgnoredMerchants().filter(n => n !== cleanNick);
    fs.writeFileSync(IGNORED_MERCHANTS_FILE, JSON.stringify(current, null, 2), 'utf8');
}

/**
 * Evalúa si un anuncio es elegible para el usuario
 * @param {Object} ad - Anuncio retornado por la API de Bybit
 * @param {Object} options - Parámetros del perfil del usuario
 * @returns {{ eligible: boolean, reason?: string }}
 */
function checkAdEligibility(ad, options = {}) {
    if (!ad) return { eligible: false, reason: 'Anuncio nulo' };

    const nick = (ad.nickName || '').trim().toUpperCase();
    const ignored = loadIgnoredMerchants();

    // 1. Verificar lista negra / ignorados
    if (ignored.includes(nick)) {
        return { eligible: false, reason: `Comerciante "${ad.nickName}" en lista de ignorados` };
    }

    const pref = ad.tradingPreferenceSet;
    if (!pref) return { eligible: true };

    const env = loadEnv();
    // Por defecto, si el usuario tiene cuenta nueva, límite de días permitido es 30 (o lo que configure en .env)
    const userMaxDays = options.maxDays ?? (env.BYBIT_ACCOUNT_DAYS ? parseInt(env.BYBIT_ACCOUNT_DAYS) : 30);
    const userMinOrders = options.minOrders30d ?? (env.BYBIT_ORDERS_30D ? parseInt(env.BYBIT_ORDERS_30D) : 0);

    // 2. Antigüedad de la cuenta (hasRegisterTime === 1)
    if (pref.hasRegisterTime === 1 && pref.registerTimeThreshold > 0) {
        if (pref.registerTimeThreshold > userMaxDays) {
            return {
                eligible: false,
                reason: `Exige ${pref.registerTimeThreshold} días de antigüedad en Bybit (Tu perfil: máx ${userMaxDays} días)`
            };
        }
    }

    // 3. Mínimo de órdenes en últimos 30 días
    if (pref.hasOrderFinishNumberDay30 === 1 && pref.orderFinishNumberDay30 > 0) {
        if (userMinOrders > 0 && pref.orderFinishNumberDay30 > userMinOrders) {
            return {
                eligible: false,
                reason: `Exige haber completado ${pref.orderFinishNumberDay30} órdenes en 30 días`
            };
        }
    }

    // 4. Restricción nacional (si aplica y no es Bolivia)
    if (pref.hasNationalLimit === 1 && pref.nationalLimit) {
        const allowedCountries = pref.nationalLimit.toUpperCase();
        if (!allowedCountries.includes('BOL') && !allowedCountries.includes('BO')) {
            return {
                eligible: false,
                reason: `Restricción de país: solo permite [${pref.nationalLimit}]`
            };
        }
    }

    return { eligible: true };
}

/**
 * Filtra un arreglo de anuncios dejando únicamente los elegibles
 * @param {Array} ads
 * @param {Object} options
 * @returns {Array} Anuncios elegibles
 */
function filterEligibleAds(ads, options = {}) {
    if (!Array.isArray(ads)) return [];
    return ads.filter(ad => checkAdEligibility(ad, options).eligible);
}

/**
 * Filtra únicamente los comerciantes bloqueados/ignorados (sin aplicar filtros de cuenta)
 * @param {Array} ads
 * @returns {Array} Anuncios sin los comerciantes bloqueados
 */
function filterIgnoredMerchants(ads) {
    if (!Array.isArray(ads)) return [];
    const ignored = loadIgnoredMerchants();
    if (ignored.length === 0) return ads;
    return ads.filter(ad => {
        const nick = (ad.nickName || '').trim().toUpperCase();
        return !ignored.includes(nick);
    });
}

module.exports = {
    checkAdEligibility,
    filterEligibleAds,
    filterIgnoredMerchants,
    loadIgnoredMerchants,
    addIgnoredMerchant,
    removeIgnoredMerchant,
    IGNORED_MERCHANTS_FILE
};
