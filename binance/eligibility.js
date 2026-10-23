/**
 * MÓDULO DE GESTIÓN DE COMERCIANTES IGNORADOS / LISTA NEGRA BINANCE P2P
 */

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config');

const IGNORED_MERCHANTS_BINANCE_FILE = path.join(__dirname, '../ignored_merchants_binance.json');

function loadIgnoredMerchants() {
    let list = [];
    if (fs.existsSync(IGNORED_MERCHANTS_BINANCE_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(IGNORED_MERCHANTS_BINANCE_FILE, 'utf8'));
            if (Array.isArray(data)) list = data;
        } catch (e) {}
    }

    // Cargar también de .env si existe BINANCE_IGNORED_MERCHANTS
    const env = loadEnv();
    if (env.BINANCE_IGNORED_MERCHANTS) {
        const fromEnv = env.BINANCE_IGNORED_MERCHANTS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
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
        fs.writeFileSync(IGNORED_MERCHANTS_BINANCE_FILE, JSON.stringify(current, null, 2), 'utf8');
    }
}

function removeIgnoredMerchant(nickName) {
    if (!nickName) return;
    const cleanNick = nickName.trim().toUpperCase();
    const current = loadIgnoredMerchants().filter(n => n !== cleanNick);
    fs.writeFileSync(IGNORED_MERCHANTS_BINANCE_FILE, JSON.stringify(current, null, 2), 'utf8');
}

/**
 * Filtra anuncios de Binance descartando los que pertenezcan a comerciantes en la lista negra
 * @param {Array} ads - Array de anuncios de Binance (formato { adv, advertiser })
 * @returns {Array} Anuncios filtrados
 */
function filterIgnoredMerchants(ads) {
    const ignored = loadIgnoredMerchants();
    if (ignored.length === 0) return ads || [];
    return (ads || []).filter(item => {
        const nick = (item?.advertiser?.nickName || item?.nickName || '').trim().toUpperCase();
        return !ignored.includes(nick);
    });
}

module.exports = {
    loadIgnoredMerchants,
    addIgnoredMerchant,
    removeIgnoredMerchant,
    filterIgnoredMerchants,
    IGNORED_MERCHANTS_BINANCE_FILE
};
