/**
 * utils/radar_runtime.js — Helpers compartidos entre binance_radar y bybit_radar.
 *
 * Extrae las 5 porciones de código que eran idénticas en ambos radars para que
 * un bug encontrado se corrija en un solo lugar y futuras adiciones (fee, limpieza,
 * tracking de ejecuciones) se hagan sin re-pegar bloques:
 *
 *   1. createTradeHistoryWriter   → recordTradeInHistory (writer JSON de trades)
 *   2. createLegacyLoggerAdapter  → logOpportunity (adapter al radar_logger)
 *   3. installFlushOnExit         → process.on('exit' / 'SIGINT') con flush
 *   4. createCooldownGuard        → anti órdenes dobles (lastOrderTime + chequeo)
 *   5. createTradeActionRunner    → runTradeAction (compra/venta/marcar + CSV + logger)
 *
 * NO toca lógica específica de cada exchange (fetchMarket, analyzeGaps, renderAlert,
 * teclas específicas, cálculo de limits). Esas quedan en sus radars.
 */

const fs = require('fs');

// =============================================================
// 1. createTradeHistoryWriter
// =============================================================
/**
 * Fabrica un `recordTradeInHistory({type, cryptoAmount, price, fiatAmount, counterparty})`
 * que escribe el JSON de trades del radar (reemplaza la función que estaba duplicada
 * en ambos radars con la única diferencia del id prefix y el nombre del exchange).
 */
function createTradeHistoryWriter({ historyFile, exchange = 'radar' }) {
    const prefix = exchange.toUpperCase();
    const sourceName = exchange === 'binance' ? 'Binance'
                      : exchange === 'bybit'   ? 'Bybit'
                      : exchange;
    return function recordTradeInHistory({ type, cryptoAmount, price, fiatAmount, counterparty }) {
        let history = [];
        if (fs.existsSync(historyFile)) {
            try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch (e) {}
        }
        const now = new Date();
        history.push({
            id: `${prefix}-RADAR-${Date.now()}`,
            date: now.toISOString().slice(0, 10),
            timestamp: now.toISOString(),
            type: type,                           // 'COMPRA' o 'VENTA'
            cryptoAmount: parseFloat(cryptoAmount),
            fiatAmount: parseFloat(fiatAmount),
            price: parseFloat(price),
            profitBob: 0,
            bank: 'BANCO SOL',
            counterparty: counterparty,
            status: 'EXITOSO',
            reason: `Ejecutado desde Radar de Brechas ${sourceName}`
        });
        try {
            fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
        } catch (e) {
            console.error('[radar_runtime] Error al escribir trade history:', e.message);
        }
    };
}

// =============================================================
// 2. createLegacyLoggerAdapter
// =============================================================
/**
 * Adapter que envuelve el radar_logger moderno con la firma vieja de `logOpportunity`.
 * Mantener este adapter permite que call sites existentes del radar sigan llamando
 * `logOpportunity(gap)` o `logOpportunity(gap, { executed: true, side, amountUsdt })`
 * sin cambios, mientras el logger decide internamente OPEN/UPDATE/CLOSE/EXEC.
 */
function createLegacyLoggerAdapter(radarLogger) {
    return function logOpportunity(opp, execution = { executed: false }) {
        if (execution.executed) {
            radarLogger.logExecution(opp, execution);
        } else {
            radarLogger.trackGap(opp);
        }
    };
}

// =============================================================
// 3. installFlushOnExit
// =============================================================
/**
 * Instala handlers de 'exit' y SIGINT en process para que el radar_logger
 * haga flush del .json legacy antes de cerrar. Idempotente por radar.
 */
function installFlushOnExit(radarLogger) {
    process.on('exit', () => {
        try { radarLogger.flushNow(); } catch (e) {}
    });
    process.on('SIGINT', () => {
        try { radarLogger.flushNow(); } catch (e) {}
        process.exit(0);
    });
}

// =============================================================
// 4. createCooldownGuard
// =============================================================
/**
 * Guard de cooldown post-ejecución para prevenir órdenes dobles cuando el
 * usuario mantiene presionada una tecla o cuando Playwright demora navegando.
 *
 * Uso:
 *   const cooldown = createCooldownGuard({ cooldownMs: 5000 });
 *   if (cooldown.isActive()) { console.log('wait ' + cooldown.remaining() + 'ms'); return; }
 *   cooldown.stamp();  // antes y después de la orden
 */
function createCooldownGuard({ cooldownMs = 5000 } = {}) {
    let lastOrderTime = 0;
    return {
        cooldownMs,
        remaining() {
            const r = cooldownMs - (Date.now() - lastOrderTime);
            return r > 0 ? r : 0;
        },
        isActive() {
            return this.remaining() > 0;
        },
        stamp() {
            lastOrderTime = Date.now();
        },
        reset() {
            lastOrderTime = 0;
        }
    };
}

// =============================================================
// 5. createTradeActionRunner
// =============================================================
/**
 * Fabrica la función `runTradeAction` compartida entre los dos radars.
 * Toda la lógica de orquestación (estados, cooldown, log, grabar trade, mensajes)
 * vive aquí. Lo específico del exchange se inyecta vía `executor`.
 *
 * @param {Object} opts
 * @param {Function} opts.executor
 *        Async: ({ side, merchantNick, price, amountUsdt }) → Promise<void>.
 *        Debe ser `executeBinanceTakerOrder` o `executeBybitTakerOrder`.
 * @param {Function} opts.logOpportunity
 *        Adapter del logger (ver createLegacyLoggerAdapter).
 * @param {Function} opts.recordTradeInHistory
 *        Writer del JSON de trades (ver createTradeHistoryWriter).
 * @param {Object} opts.state
 *        Puente mutable al estado del radar. Debe exponer:
 *          setExecutingOrder(bool), setPaused(bool), setCurrentActiveGap(any)
 * @param {Object} opts.cooldown
 *        Instancia de createCooldownGuard.
 * @param {string} opts.exchangeLabel
 *        "en Binance" o "" (Bybit no agregaba sufijo en el log).
 * @param {number} opts.pricePrecision
 *        Decimales para formatear el precio en el mensaje final (2 Binance, 3 Bybit).
 *
 * @returns Async function con firma:
 *   runTradeAction({ gap, side, merchantNick, price, actionLabel, tradeAmount })
 */
function createTradeActionRunner({
    executor,
    logOpportunity,
    recordTradeInHistory,
    state,
    cooldown,
    exchangeLabel = '',
    pricePrecision = 2
}) {
    if (typeof executor !== 'function') throw new Error('createTradeActionRunner: executor es requerido');
    if (typeof logOpportunity !== 'function') throw new Error('createTradeActionRunner: logOpportunity es requerido');
    if (typeof recordTradeInHistory !== 'function') throw new Error('createTradeActionRunner: recordTradeInHistory es requerido');
    if (!state || typeof state.setExecutingOrder !== 'function') throw new Error('createTradeActionRunner: state inválido');
    if (!cooldown || typeof cooldown.stamp !== 'function') throw new Error('createTradeActionRunner: cooldown inválido');

    const suffix = exchangeLabel ? ` ${exchangeLabel}` : '';

    return async function runTradeAction({ gap, side, merchantNick, price, actionLabel, tradeAmount }) {
        state.setExecutingOrder(true);
        state.setPaused(true);
        cooldown.stamp();                      // marca inicio del cooldown
        state.setCurrentActiveGap(null);       // libera gap para no re-disparar

        if (!gap || !gap.limits || !gap.limits.hasOverlap) {
            console.log('\n⚠️ [ADVERTENCIA]: Los límites no son directamente compatibles.');
            console.log(`Motivo: ${gap && gap.limits ? gap.limits.reason : 'gap sin análisis de límites'}`);
        }
        console.log(`\n\n⚡ [ACCION DISPARADA]: Iniciando ${actionLabel} semi-automática de ${tradeAmount} USDT${suffix}...`);

        try {
            await executor({ side, merchantNick, price, amountUsdt: tradeAmount });

            logOpportunity(gap, { executed: true, side, amountUsdt: tradeAmount });

            recordTradeInHistory({
                type: side === 'BUY' ? 'COMPRA' : 'VENTA',
                cryptoAmount: tradeAmount,
                price: price,
                fiatAmount: tradeAmount * price,
                counterparty: merchantNick
            });

            console.log(`\n✅ [REGISTRADO EN CSV]: ${actionLabel} registrada (${tradeAmount} USDT a ${price.toFixed(pricePrecision)} BOB).`);
        } catch (e) {
            console.error(`Error al ejecutar pedido ${side}${suffix}:`, e.message);
        } finally {
            state.setExecutingOrder(false);
            state.setPaused(false);
            cooldown.stamp();                  // reinicia el cooldown DESDE EL FIN de la orden
            console.log(`\n▶️ Radar reanudado. Cooldown ${cooldown.cooldownMs / 1000}s activo para prevenir órdenes dobles.`);
        }
    };
}

module.exports = {
    createTradeHistoryWriter,
    createLegacyLoggerAdapter,
    installFlushOnExit,
    createCooldownGuard,
    createTradeActionRunner
};
