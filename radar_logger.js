/**
 * Logger eficiente para los radars (binance_radar y bybit_radar).
 *
 * Reemplaza el patrón anterior de leer+parse+stringify+write del JSON entero
 * en cada ciclo (que destruía el disco con --ultra 250ms) por:
 *
 *  1. JSONL append-only con rotación diaria:
 *       bybit_market_history_YYYY-MM-DD.jsonl
 *     Cada evento es una línea → append O(1), nunca re-serializa el array.
 *
 *  2. CSV append-only (sin cambios de formato en Excel), con nueva columna
 *     "Evento" al final (OPEN/UPDATE/CLOSE/EXEC) para filtrar.
 *
 *  3. Debounce por ESTADO en vez de por tiempo:
 *       - Primera vez que aparece un gap   → OPEN
 *       - Mismo gap con cambio material    → UPDATE
 *       - Diferente gap sustituye al activo → CLOSE previo + OPEN nuevo
 *       - Nada escrito si todo igual        → silencio
 *     Esto elimina las ~80 filas duplicadas por hora del esquema viejo.
 *
 *  4. El .json histórico legacy sigue siendo re-escrito en background cada 60s
 *     (desde el JSONL del día) para que herramientas antiguas sigan funcionando,
 *     sin pagarlo en el loop crítico.
 *
 * Uso en un radar:
 *   const { createRadarLogger } = require('./utils/radar_logger');
 *   const logger = createRadarLogger({
 *       exchange: 'bybit',
 *       csvPath: path.join(__dirname, 'bybit_market_history.csv'),
 *       jsonPath: path.join(__dirname, 'bybit_market_history.json'),
 *       jsonlDir: __dirname
 *   });
 *
 *   // En cada ciclo cuando hay un gap detectado:
 *   logger.trackGap(opp);  // decide internamente si escribe OPEN/UPDATE/CLOSE
 *
 *   // Cuando el usuario ejecuta una orden (compra/venta/marcar manual):
 *   logger.logExecution(opp, { side: 'BUY', amountUsdt: 100 });
 *
 *   // Cuando el radar deja de ver gaps en un ciclo:
 *   logger.markNoGap();  // emite CLOSE del gap activo si lo había
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CSV_HEADERS = [
    'Fecha_Hora',
    'Tipo_Registro',
    'Compre_En_Oportunidad',
    'Oportunidad_Compra_BOB',
    'Vendedor',
    'Pico_Venta_BOB',
    'Comprador_Pico',
    'Spread_Ganancia_BOB',
    'Margen_Porcentaje',
    'Cantidad_USDT',
    'Total_BOB',
    'Ganancia_Estimada_BOB',
    'Limites_Compra_BOB',
    'Limites_Venta_BOB',
    'Compatibilidad_Limites',
    'Detalle',
    'Evento'
];

function todayStr() {
    // YYYY-MM-DD en zona horaria de La Paz
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' });
}

function nowBoliviaStr() {
    return new Date().toLocaleString('es-BO', { timeZone: 'America/La_Paz' });
}

function priceChangedMaterially(a, b) {
    // Un cambio en precio de compra o venta >= 0.005 BOB, o cambio de contraparte, es material.
    if (!a || !b) return true;
    if (Math.abs(a.buyPrice - b.buyPrice) >= 0.005) return true;
    if (Math.abs(a.sellPrice - b.sellPrice) >= 0.005) return true;
    if ((a.sellerNick || '') !== (b.sellerNick || '')) return true;
    if ((a.buyerNick || '') !== (b.buyerNick || '')) return true;
    return false;
}

function createRadarLogger({ exchange, csvPath, jsonPath, jsonlDir, defaultTradeUsdt = 100, materialSpreadDelta = 0.005 }) {
    // Estado interno de la "brecha activa" (si la hay)
    let activeGap = null;         // { key, buyPrice, sellPrice, sellerNick, buyerNick, firstSeenAt, lastUpdatedAt }
    let legacyJsonDirty = false;  // si hay escrituras pendientes de volcar al .json legacy
    let legacyFlushTimer = null;

    // ----------------- CSV -----------------
    function ensureCsvHeaders() {
        if (!fs.existsSync(csvPath)) {
            fs.writeFileSync(csvPath, DEFAULT_CSV_HEADERS.join(';') + '\n', 'utf8');
            return;
        }
        try {
            const firstLine = (fs.readFileSync(csvPath, 'utf8').split('\n')[0]) || '';
            // Si el header está desactualizado (sin "Evento"), rotar el archivo viejo a .backup
            if (!firstLine.includes('Evento')) {
                const backupPath = csvPath.replace(/\.csv$/i, '_backup_pre_logger.csv');
                try { fs.copyFileSync(csvPath, backupPath); } catch (e) {}
                fs.writeFileSync(csvPath, DEFAULT_CSV_HEADERS.join(';') + '\n', 'utf8');
            }
        } catch (e) {}
    }

    // ----------------- JSONL (per-day append-only) -----------------
    function jsonlPathForToday() {
        return path.join(jsonlDir, `${exchange}_market_history_${todayStr()}.jsonl`);
    }

    function appendJsonl(record) {
        try {
            fs.appendFileSync(jsonlPathForToday(), JSON.stringify(record) + '\n', 'utf8');
        } catch (e) {
            // Logging best-effort: no romper el radar por un fallo de I/O
        }
    }

    // ----------------- Legacy .json flush (background) -----------------
    function scheduleLegacyFlush() {
        if (legacyFlushTimer) return;
        legacyFlushTimer = setTimeout(() => {
            legacyFlushTimer = null;
            if (!legacyJsonDirty) return;
            try {
                // Reconstruir desde el JSONL de hoy, cap a últimas 500 entradas
                const file = jsonlPathForToday();
                if (!fs.existsSync(file)) {
                    legacyJsonDirty = false;
                    return;
                }
                const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
                const entries = lines.slice(-500).map(l => {
                    try { return JSON.parse(l); } catch { return null; }
                }).filter(Boolean);
                fs.writeFileSync(jsonPath, JSON.stringify(entries, null, 2), 'utf8');
                legacyJsonDirty = false;
            } catch (e) {
                // Mantener dirty para reintento en el próximo tick
            }
        }, 60000); // Flush cada 60s
        if (legacyFlushTimer.unref) legacyFlushTimer.unref();
    }

    // ----------------- CORE: emitir evento -----------------
    function emit({ eventType, opp, execution }) {
        ensureCsvHeaders();

        const l = opp.limits || {};
        const compatStr = l.hasOverlap ? 'COMPATIBLE' : 'INCOMPATIBLE';
        const exec = execution || { executed: false };
        const tradeUsdt = exec.amountUsdt || l.suggestedTradeUsdt || defaultTradeUsdt;

        let tipoRegistro = 'OPORTUNIDAD_DETECTADA';
        let compreEnOportunidad = 'NO';
        let totalBob = parseFloat((tradeUsdt * opp.buyPrice).toFixed(2));
        const spread = typeof opp.spread === 'number' ? opp.spread : (opp.sellPrice - opp.buyPrice);
        let gananciaEstimadaBob = parseFloat((spread * tradeUsdt).toFixed(2));

        if (exec.executed) {
            if (exec.side === 'BUY') {
                tipoRegistro = 'COMPRA_EJECUTADA';
                compreEnOportunidad = 'SI';
                totalBob = parseFloat((tradeUsdt * opp.buyPrice).toFixed(2));
            } else if (exec.side === 'SELL') {
                tipoRegistro = 'VENTA_EJECUTADA';
                compreEnOportunidad = 'VENTA_REALIZADA';
                totalBob = parseFloat((tradeUsdt * opp.sellPrice).toFixed(2));
            }
        }

        const sellerNick = opp.seller?.nickName || '';
        const buyerNick = opp.buyer?.nickName || '';
        const marginPct = typeof opp.marginPercent === 'number' || typeof opp.marginPercent === 'string'
            ? opp.marginPercent
            : (opp.buyPrice > 0 ? ((spread / opp.buyPrice) * 100).toFixed(2) : 0);
        const buyMinBob = l.buy?.minBob ?? 0;
        const buyMaxBob = l.buy?.maxBob ?? 0;
        const sellMinBob = l.sell?.minBob ?? 0;
        const sellMaxBob = l.sell?.maxBob ?? 0;

        const row = [
            `"${nowBoliviaStr()}"`,
            `"${tipoRegistro}"`,
            `"${compreEnOportunidad}"`,
            opp.buyPrice,
            `"${sellerNick}"`,
            opp.sellPrice,
            `"${buyerNick}"`,
            spread.toFixed(3),
            `"${marginPct}%"`,
            tradeUsdt,
            totalBob,
            gananciaEstimadaBob,
            `"${(+buyMinBob).toFixed(2)} - ${(+buyMaxBob).toFixed(2)} BOB"`,
            `"${(+sellMinBob).toFixed(2)} - ${(+sellMaxBob).toFixed(2)} BOB"`,
            `"${compatStr}"`,
            `"Compra a ${(+opp.buyPrice).toFixed(3)} (${sellerNick}) vs venta a ${(+opp.sellPrice).toFixed(3)} (${buyerNick})"`,
            `"${eventType}"`
        ].join(';');

        try { fs.appendFileSync(csvPath, row + '\n', 'utf8'); } catch (e) {}

        appendJsonl({
            timestamp: new Date().toISOString(),
            dateLocal: nowBoliviaStr(),
            exchange,
            event: eventType,
            tipoRegistro,
            compreEnOportunidad,
            buyPrice: +opp.buyPrice,
            sellPrice: +opp.sellPrice,
            spread: +spread.toFixed(3),
            marginPercent: marginPct,
            sellerNick,
            buyerNick,
            tradeUsdt,
            totalBob,
            gananciaEstimadaBob,
            limits: l,
            activeGapAgeMs: activeGap && activeGap.firstSeenAt ? (Date.now() - activeGap.firstSeenAt) : null
        });

        legacyJsonDirty = true;
        scheduleLegacyFlush();
    }

    // ----------------- Public API -----------------

    /**
     * Llamar cada vez que el radar detecte una brecha en el ciclo actual.
     * El logger decide internamente si emitir OPEN, UPDATE o nada.
     */
    function trackGap(opp) {
        if (!opp) return;
        const snapshot = {
            key: `${opp.seller?.nickName || '?'}_${opp.buyPrice}_${opp.buyer?.nickName || '?'}_${opp.sellPrice}`,
            buyPrice: +opp.buyPrice,
            sellPrice: +opp.sellPrice,
            sellerNick: opp.seller?.nickName || '',
            buyerNick: opp.buyer?.nickName || '',
            opp: opp  // guardar el gap completo para emitir CLOSE con sus limits reales
        };

        if (!activeGap) {
            activeGap = { ...snapshot, firstSeenAt: Date.now(), lastUpdatedAt: Date.now() };
            emit({ eventType: 'OPEN', opp });
            return;
        }

        if (activeGap.key === snapshot.key) {
            activeGap.lastUpdatedAt = Date.now();
            return;
        }

        if (priceChangedMaterially(activeGap, snapshot)) {
            emit({ eventType: 'CLOSE', opp: activeGap.opp });
            activeGap = { ...snapshot, firstSeenAt: Date.now(), lastUpdatedAt: Date.now() };
            emit({ eventType: 'OPEN', opp });
            return;
        }

        activeGap.lastUpdatedAt = Date.now();
    }

    /**
     * Llamar cuando el ciclo del radar NO detectó ninguna brecha (gaps.length === 0).
     * Emite CLOSE si había un gap activo.
     */
    function markNoGap() {
        if (!activeGap) return;
        emit({ eventType: 'CLOSE', opp: activeGap.opp });
        activeGap = null;
    }

    /**
     * Llamar cuando el usuario ejecuta compra/venta/marca manual.
     * Siempre escribe, no está sujeto a debounce.
     */
    function logExecution(opp, execution) {
        emit({ eventType: 'EXEC', opp, execution });
    }

    /**
     * Para cierre limpio del proceso (ej. Ctrl+C): fuerza el flush del legacy json.
     */
    function flushNow() {
        if (legacyFlushTimer) {
            clearTimeout(legacyFlushTimer);
            legacyFlushTimer = null;
        }
        if (!legacyJsonDirty) return;
        try {
            const file = jsonlPathForToday();
            if (fs.existsSync(file)) {
                const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
                const entries = lines.slice(-500).map(l => {
                    try { return JSON.parse(l); } catch { return null; }
                }).filter(Boolean);
                fs.writeFileSync(jsonPath, JSON.stringify(entries, null, 2), 'utf8');
                legacyJsonDirty = false;
            }
        } catch (e) {}
    }

    return {
        trackGap,
        markNoGap,
        logExecution,
        flushNow
    };
}

module.exports = { createRadarLogger };
