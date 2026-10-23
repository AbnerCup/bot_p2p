/**
 * SISTEMA INTEGRAL DE AUDITORÍA DIARIA, GASTOS Y CIERRE FINANCIERO (EJERCICIO)
 * 
 * Monitorea el ciclo financiero completo de trading P2P:
 * 1. APERTURA (Inicio del Día):
 *    - Captura saldos reales de Binance (USDT), Bybit (USDT) y Banco Sol (BOB).
 *    - Calcula el tipo de cambio promedio del día (Bybit + Binance).
 *    - Convierte USDT a Bolivianos y fija el Capital Inicial del Día.
 * 
 * 2. GASTOS E INGRESOS DEL DÍA:
 *    - Permite registrar gastos personales y operativos (BOB o USDT).
 *    - Permite registrar ingresos externos o fondos holdeados (BOB o USDT)
 *      para evitar que se computen falsamente como ganancia de trading.
 * 
 * 3. CIERRE DEL DÍA:
 *    - Captura los saldos finales de Binance, Bybit y Banco Sol.
 *    - Aplica la fórmula financiera de beneficio neto real:
 *      Ganancia Neta = (Total Final BOB + Gastos BOB - Ingresos BOB) - Total Inicial BOB
 *    - Almacena en `diario_ledger.json` y `diario_ledger.csv` para auditoría permanente.
 * 
 * 4. REPORTES POR RANGOS / SEMANALES (SÁBADOS):
 *    - Consolida los beneficios diarios acumulados por semana o rango de fechas.
 * 
 * Comandos soportados:
 *   node ejercicio.js                     (Auditoría y estado en tiempo real de hoy)
 *   node ejercicio.js --abrir             (Registrar inicio del día / apertura)
 *   node ejercicio.js --cerrar            (Registrar cierre del día y calcular ganancia neta)
 *   node ejercicio.js --gasto 50 "Almuerzo" (Registrar un gasto del día en BOB)
 *   node ejercicio.js --gasto 10 $ "Servidor" (Registrar un gasto en USDT)
 *   node ejercicio.js --gastos            (Ver lista de gastos de hoy)
 *   node ejercicio.js --ingreso 129 $ "Fondos holdeados" (Registrar ingreso / hold en USDT)
 *   node ejercicio.js --ingreso 1500 "Depósito" (Registrar ingreso / aporte en BOB)
 *   node ejercicio.js --ingresos          (Ver lista de ingresos/hold de hoy)
 *   node ejercicio.js --semana            (Reporte consolidado de la semana)
 *   node ejercicio.js --rango 2026-09-15 2026-09-21 (Reporte por rango de fechas)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchBybitP2P } = require('./bybit/market');
const { fetchBinanceP2P } = require('./binance/market');
const { getBancoSolLiveBalance } = require('./banks/bancosol');
const { getLiveBybitBalancesFromApi } = require('./bybit/balances');
const { getLiveBinanceBalancesFromApi } = require('./binance/balances');
const { loadIgnoredMerchants } = require('./bybit/eligibility');

// Archivos persistentes
const HISTORY_FILE = path.join(__dirname, 'history.json');
const CAPITAL_FILE = path.join(__dirname, 'capital.json');
const DIARIO_LEDGER_FILE = path.join(__dirname, 'diario_ledger.json');
const DIARIO_LEDGER_CSV = path.join(__dirname, 'diario_ledger.csv');

function formatNum(n, dec = 2) {
    if (typeof n !== 'number' || isNaN(n)) return '0.00';
    return n.toLocaleString('es-BO', {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec
    });
}

function getTodayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' });
}

function getTimeStr() {
    return new Date().toLocaleTimeString('es-BO', { hour12: false, timeZone: 'America/La_Paz' });
}

function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function loadLedger() {
    if (!fs.existsSync(DIARIO_LEDGER_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(DIARIO_LEDGER_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveLedger(ledger) {
    fs.writeFileSync(DIARIO_LEDGER_FILE, JSON.stringify(ledger, null, 2), 'utf8');
}

function initLedgerCSV() {
    const headers = [
        'Fecha',
        'Hora_Apertura',
        'Apertura_BOB',
        'Hora_Cierre',
        'Cierre_BOB',
        'Gastos_BOB',
        'Ingresos_BOB',
        'Ganancia_Neta_BOB',
        'ROI_Porcentaje',
        'Tasa_Promedio_BOB',
        'Bybit_Final_USDT',
        'Binance_Final_USDT',
        'BancoSol_Final_BOB',
        'Detalle'
    ].join(';');

    if (!fs.existsSync(DIARIO_LEDGER_CSV)) {
        fs.writeFileSync(DIARIO_LEDGER_CSV, headers + '\n', 'utf8');
    } else {
        try {
            const content = fs.readFileSync(DIARIO_LEDGER_CSV, 'utf8');
            const lines = content.split('\n');
            if (lines[0] && !lines[0].includes('Ingresos_BOB')) {
                lines[0] = headers;
                fs.writeFileSync(DIARIO_LEDGER_CSV, lines.join('\n'), 'utf8');
            }
        } catch (e) {}
    }
}

function appendClosingToCSV(record) {
    initLedgerCSV();
    const row = [
        `"${record.date}"`,
        `"${record.openTime || ''}"`,
        (record.openBob || 0).toFixed(2),
        `"${record.closeTime || ''}"`,
        (record.closeBob || 0).toFixed(2),
        (record.expensesBob || 0).toFixed(2),
        (record.incomesBob || 0).toFixed(2),
        (record.profitBob || 0).toFixed(2),
        `"${(record.roiPercent || 0).toFixed(2)}%"`,
        (record.rateAvg || 0).toFixed(3),
        (record.bybitUsdt || 0).toFixed(2),
        (record.binanceUsdt || 0).toFixed(2),
        (record.bancoSolBob || 0).toFixed(2),
        `"Ganancia neta calculada con gastos e ingresos/hold incluidos"`
    ].join(';');

    // Si ya existe la fecha en el CSV, reemplazarla para evitar duplicar fila
    const lines = fs.readFileSync(DIARIO_LEDGER_CSV, 'utf8').split('\n').filter(Boolean);
    const updated = [lines[0]];
    let replaced = false;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].startsWith(`"${record.date}"`)) {
            updated.push(row);
            replaced = true;
        } else {
            updated.push(lines[i]);
        }
    }
    if (!replaced) {
        updated.push(row);
    }
    fs.writeFileSync(DIARIO_LEDGER_CSV, updated.join('\n') + '\n', 'utf8');
}

/**
 * Consulta los saldos en vivo de las 3 plataformas y calcula el tipo de cambio promedio
 */
async function fetchLiveFinancialSnapshot(options = {}) {
    const ignored = loadIgnoredMerchants();

    // 1. Obtener libros de órdenes para tasa promedio
    const [bybitSellers, bybitBuyers, binanceSellers, binanceBuyers] = await Promise.all([
        fetchBybitP2P({ side: '1', size: 5 }).catch(() => []),
        fetchBybitP2P({ side: '0', size: 5 }).catch(() => []),
        fetchBinanceP2P({ tradeType: 'BUY', rows: 5 }).catch(() => []),
        fetchBinanceP2P({ tradeType: 'SELL', rows: 5 }).catch(() => [])
    ]);

    // Filtrar ignorados
    const cleanBybitSellers = bybitSellers.filter(s => !ignored.includes((s.nickName || '').toUpperCase()));
    const cleanBybitBuyers = bybitBuyers.filter(b => !ignored.includes((b.nickName || '').toUpperCase()));
    const cleanBinanceSellers = (binanceSellers || []).filter(item => {
        const nick = (item.advertiser?.nickName || '').toUpperCase();
        return !ignored.includes(nick);
    });
    const cleanBinanceBuyers = (binanceBuyers || []).filter(item => {
        const nick = (item.advertiser?.nickName || '').toUpperCase();
        return !ignored.includes(nick);
    });

    const bybitBuy = parseFloat(cleanBybitSellers[0]?.price || 0);
    const bybitSell = parseFloat(cleanBybitBuyers[0]?.price || 0);
    const binanceBuy = parseFloat(cleanBinanceSellers[0]?.adv?.price || 0);
    const binanceSell = parseFloat(cleanBinanceBuyers[0]?.adv?.price || 0);

    const validRates = [bybitBuy, bybitSell, binanceBuy, binanceSell].filter(r => r > 0);
    const rateAvg = validRates.length > 0
        ? parseFloat((validRates.reduce((a, b) => a + b, 0) / validRates.length).toFixed(3))
        : 12.05;

    // 2. Obtener saldos de las plataformas
    let bancoSolBob = 1998.31;
    if (fs.existsSync(CAPITAL_FILE)) {
        try {
            const cap = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
            if (typeof cap.bancoSolBob === 'number') bancoSolBob = cap.bancoSolBob;
        } catch (e) {}
    }
    if (options.customSol !== undefined) {
        bancoSolBob = options.customSol;
    }

    const [bankBal, bybitApiBal, binanceApiBal] = await Promise.all([
        options.forceLiveBank ? getBancoSolLiveBalance(true).catch(() => bancoSolBob) : Promise.resolve(bancoSolBob),
        getLiveBybitBalancesFromApi().catch(() => null),
        getLiveBinanceBalancesFromApi().catch(() => null)
    ]);

    if (typeof bankBal === 'number' && bankBal >= 0) {
        bancoSolBob = bankBal;
    }

    const bybitUsdt = bybitApiBal ? (bybitApiBal.totalUsdt || bybitApiBal.usdtFunding || 0) : 0;
    const binanceUsdt = binanceApiBal ? (binanceApiBal.totalUsdt || binanceApiBal.usdtFunding || 0) : 0;

    const bybitBob = parseFloat((bybitUsdt * rateAvg).toFixed(2));
    const binanceBob = parseFloat((binanceUsdt * rateAvg).toFixed(2));
    const totalCapitalBob = parseFloat((bancoSolBob + bybitBob + binanceBob).toFixed(2));
    const totalCapitalUsdt = rateAvg > 0 ? parseFloat((totalCapitalBob / rateAvg).toFixed(2)) : 0;

    return {
        timestamp: new Date().toISOString(),
        timeStr: getTimeStr(),
        dateStr: getTodayStr(),
        rates: {
            rateAvg,
            bybitBuy,
            bybitSell,
            binanceBuy,
            binanceSell
        },
        balances: {
            bybitUsdt,
            bybitBob,
            binanceUsdt,
            binanceBob,
            bancoSolBob,
            totalCapitalBob,
            totalCapitalUsdt
        }
    };
}

/**
 * Parser inteligente de montos y monedas (BOB / USDT / $)
 */
function parseMoneyEntry(args, primaryFlags, deleteFlags = []) {
    let flagIdx = -1;
    for (const f of primaryFlags) {
        const idx = args.findIndex(a => a === f || a.toLowerCase() === f.toLowerCase());
        if (idx !== -1) {
            flagIdx = idx;
            break;
        }
    }

    // Comprobar si se solicitó borrado
    let deleteId = null;
    for (const df of deleteFlags) {
        const idx = args.findIndex(a => a === df || a.toLowerCase() === df.toLowerCase());
        if (idx !== -1 && args[idx + 1]) {
            deleteId = parseInt(args[idx + 1], 10);
            break;
        }
    }
    if (deleteId !== null) {
        return { isDelete: true, deleteId };
    }

    if (flagIdx === -1 || !args[flagIdx + 1]) {
        return { isListing: true };
    }

    const remaining = args.slice(flagIdx + 1);
    let amount = null;
    let currency = null; // 'USDT' o 'BOB'
    let descParts = [];

    for (let i = 0; i < remaining.length; i++) {
        const raw = remaining[i].trim();

        // Flags de moneda
        if (raw === '--usdt' || raw === '--usd' || raw === '-u') {
            currency = 'USDT';
            continue;
        }
        if (raw === '--bob' || raw === '--bs') {
            currency = 'BOB';
            continue;
        }

        // Indicadores sueltos de moneda
        const lower = raw.toLowerCase();
        if (['$', 'usdt', 'usd', 'u', 'dolares', 'dólares', 'dollar', 'dollars'].includes(lower)) {
            currency = 'USDT';
            continue;
        }
        if (['bob', 'bs', 'bs.', 'bolivianos'].includes(lower)) {
            currency = 'BOB';
            continue;
        }

        // Monto principal
        if (amount === null) {
            let numStr = raw;
            if (numStr.startsWith('$')) {
                currency = 'USDT';
                numStr = numStr.slice(1);
            } else if (numStr.endsWith('$')) {
                currency = 'USDT';
                numStr = numStr.slice(0, -1);
            } else if (numStr.toLowerCase().endsWith('usdt')) {
                currency = 'USDT';
                numStr = numStr.slice(0, -4);
            } else if (numStr.toLowerCase().endsWith('usd')) {
                currency = 'USDT';
                numStr = numStr.slice(0, -3);
            } else if (numStr.toLowerCase().endsWith('bob')) {
                currency = 'BOB';
                numStr = numStr.slice(0, -3);
            } else if (numStr.toLowerCase().endsWith('bs')) {
                currency = 'BOB';
                numStr = numStr.slice(0, -2);
            }

            const parsed = parseFloat(numStr.replace(',', '.'));
            if (!isNaN(parsed) && parsed > 0) {
                amount = parsed;
                continue;
            }
        }

        descParts.push(raw);
    }

    if (amount === null) {
        return { isListing: true };
    }

    if (!currency) {
        currency = 'BOB';
    }

    const description = descParts.join(' ').trim() || 'Sin descripción';
    return {
        isListing: false,
        amount,
        currency,
        description
    };
}

/**
 * 1. Comando: Apertura / Inicio del Día
 */
async function handleOpenDay(args) {
    const today = getTodayStr();
    const ledger = loadLedger();
    const force = args.includes('--force') || args.includes('-f');

    if (ledger[today] && ledger[today].opening && !force) {
        const op = ledger[today].opening;
        console.clear();
        console.log('================================================================================');
        console.log(` ⚠️ YA EXISTE UNA APERTURA REGISTRADA PARA HOY [${today}]`);
        console.log('================================================================================');
        console.log(` ⏰ Hora Apertura:        ${op.time}`);
        console.log(` 💱 Tasa Promedio Usada:  ${op.rateAvg.toFixed(3)} BOB/USDT`);
        console.log(` 🟣 Bybit:                ${formatNum(op.bybitUsdt)} USDT  (= ${formatNum(op.bybitBob)} BOB)`);
        console.log(` 🟡 Binance:              ${formatNum(op.binanceUsdt)} USDT  (= ${formatNum(op.binanceBob)} BOB)`);
        console.log(` 🏦 Banco Sol:            ${formatNum(op.bancoSolBob)} BOB`);
        console.log('────────────────────────────────────────────────────────────────────────────────');
        console.log(` 💼 TOTAL INICIO DEL DÍA: \x1b[32m\x1b[1m${formatNum(op.totalInitialBob)} BOB\x1b[0m (~${formatNum(op.totalInitialUsdt)} USDT)`);
        console.log('================================================================================');
        console.log('💡 Si deseas sobreescribir la apertura con los datos de este momento, usa:');
        console.log('   node ejercicio.js --abrir --force\n');
        return;
    }

    console.clear();
    console.log('⏳ Sincronizando saldos en vivo de Bybit, Binance y Banco Sol para la APERTURA...');
    const customSol = parseSolArg(args);
    const shouldQueryLive = !args.includes('--no-live') && customSol === undefined;
    const snap = await fetchLiveFinancialSnapshot({ customSol, forceLiveBank: shouldQueryLive });
    const b = snap.balances;
    const r = snap.rates;

    if (!ledger[today]) {
        ledger[today] = { date: today, expenses: [], incomes: [] };
    }
    if (!Array.isArray(ledger[today].incomes)) {
        ledger[today].incomes = [];
    }

    ledger[today].opening = {
        timestamp: snap.timestamp,
        time: snap.timeStr,
        rateAvg: r.rateAvg,
        bybitUsdt: b.bybitUsdt,
        bybitBob: b.bybitBob,
        binanceUsdt: b.binanceUsdt,
        binanceBob: b.binanceBob,
        bancoSolBob: b.bancoSolBob,
        totalInitialBob: b.totalCapitalBob,
        totalInitialUsdt: b.totalCapitalUsdt
    };

    saveLedger(ledger);

    console.clear();
    console.log('================================================================================');
    console.log(` 🌅 ¡APERTURA REGISTRADA CON ÉXITO! [${today} a las ${snap.timeStr}]`);
    console.log('================================================================================');
    console.log(` 💱 Tasa Promedio del Mercado: \x1b[33m\x1b[1m${r.rateAvg.toFixed(3)} BOB/USDT\x1b[0m (Bybit: ${r.bybitBuy.toFixed(3)}/${r.bybitSell.toFixed(3)} | Binance: ${r.binanceBuy.toFixed(3)}/${r.binanceSell.toFixed(3)})`);
    console.log('────────────────────────────────────────────────────────────────────────────────');
    console.log(` 🟣 Saldo Bybit:              ${formatNum(b.bybitUsdt).padStart(9, ' ')} USDT  ➔  \x1b[36m\x1b[1m${formatNum(b.bybitBob).padStart(12, ' ')} BOB\x1b[0m`);
    console.log(` 🟡 Saldo Binance:            ${formatNum(b.binanceUsdt).padStart(9, ' ')} USDT  ➔  \x1b[36m\x1b[1m${formatNum(b.binanceBob).padStart(12, ' ')} BOB\x1b[0m`);
    console.log(` 🏦 Saldo Banco Sol:                             \x1b[32m\x1b[1m${formatNum(b.bancoSolBob).padStart(12, ' ')} BOB\x1b[0m`);
    console.log('================================================================================');
    console.log(` 💰 CAPITAL INICIAL DEL DÍA:  \x1b[32m\x1b[1m${formatNum(b.totalCapitalBob).padStart(12, ' ')} BOB\x1b[0m  │  \x1b[36m${formatNum(b.totalCapitalUsdt)} USDT\x1b[0m`);
    console.log('================================================================================');
    console.log(' 👉 Registra gastos del día con:       node ejercicio.js --gasto <monto> "<detalle>"');
    console.log(' 👉 Registra fondos hold/ingreso con:  node ejercicio.js --ingreso <monto> [moneda] "<detalle>"');
    console.log(' 👉 Realiza el cierre en la noche con: node ejercicio.js --cerrar\n');
}

/**
 * 2. Comando: Registro y Consulta de Gastos del Día
 */
async function handleExpense(args) {
    const today = getTodayStr();
    const ledger = loadLedger();
    if (!ledger[today]) {
        ledger[today] = { date: today, expenses: [], incomes: [] };
    }
    if (!Array.isArray(ledger[today].expenses)) {
        ledger[today].expenses = [];
    }

    const parsed = parseMoneyEntry(args, ['--gasto', '-g', '--gastos', '-G'], ['--borrar-gasto', '--delete-gasto']);

    if (parsed.isDelete) {
        const idToDelete = parsed.deleteId;
        const prevCount = ledger[today].expenses.length;
        ledger[today].expenses = ledger[today].expenses.filter((e, idx) => e.id !== idToDelete && (idx + 1) !== idToDelete);
        saveLedger(ledger);
        console.log(`\n🗑️ Gasto eliminado. Gastos restantes hoy: ${ledger[today].expenses.length}\n`);
        return;
    }

    if (!parsed.isListing) {
        let rate = ledger[today]?.opening?.rateAvg || ledger[today]?.closing?.rateAvg;
        if (!rate || rate <= 0) {
            try {
                const snap = await fetchLiveFinancialSnapshot({ forceLiveBank: false });
                rate = snap.rates.rateAvg;
            } catch (e) {
                rate = 12.10;
            }
        }

        let amountBob = 0;
        let amountUsdt = 0;
        if (parsed.currency === 'USDT') {
            amountUsdt = parsed.amount;
            amountBob = parseFloat((amountUsdt * rate).toFixed(2));
        } else {
            amountBob = parsed.amount;
            amountUsdt = rate > 0 ? parseFloat((amountBob / rate).toFixed(2)) : 0;
        }

        const entry = {
            id: Date.now(),
            time: getTimeStr(),
            amountBob,
            amountUsdt,
            currency: parsed.currency,
            rateUsed: rate,
            description: parsed.description
        };

        ledger[today].expenses.push(entry);
        saveLedger(ledger);

        const totalG = ledger[today].expenses.reduce((s, e) => s + e.amountBob, 0);
        console.clear();
        console.log('================================================================================');
        console.log(` 💸 GASTO REGISTRADO CORRECTAMENTE [${today}]`);
        console.log('================================================================================');
        console.log(` 🕒 Hora:        ${entry.time}`);
        if (entry.currency === 'USDT') {
            console.log(` 💵 Monto:       \x1b[31m\x1b[1m-${formatNum(entry.amountUsdt)} USDT\x1b[0m  ➔  \x1b[31m\x1b[1m-${formatNum(entry.amountBob)} BOB\x1b[0m (Tasa: ${rate.toFixed(3)})`);
        } else {
            console.log(` 💵 Monto:       \x1b[31m\x1b[1m-${formatNum(entry.amountBob)} BOB\x1b[0m`);
        }
        console.log(` 📝 Descripción: ${entry.description}`);
        console.log('--------------------------------------------------------------------------------');
        console.log(` 📊 TOTAL GASTOS ACUMULADOS HOY: \x1b[31m\x1b[1m${formatNum(totalG)} BOB\x1b[0m (${ledger[today].expenses.length} registros)`);
        console.log('================================================================================\n');
        return;
    }

    // Listar gastos de hoy
    console.clear();
    console.log('================================================================================');
    console.log(` 📋 GASTOS REGISTRADOS HOY [${today}]`);
    console.log('================================================================================');
    const exps = ledger[today].expenses;
    if (exps.length === 0) {
        console.log('   (No hay gastos registrados hoy)');
    } else {
        exps.forEach((e, i) => {
            const origStr = e.currency === 'USDT'
                ? `-${formatNum(e.amountUsdt)} USDT (~${formatNum(e.amountBob)} BOB)`
                : `-${formatNum(e.amountBob)} BOB`;
            console.log(` [#${i + 1}] ${e.time} │ \x1b[31m\x1b[1m${origStr.padStart(25, ' ')}\x1b[0m │ ${e.description}`);
        });
        const sumG = exps.reduce((s, e) => s + e.amountBob, 0);
        console.log('--------------------------------------------------------------------------------');
        console.log(` 📌 TOTAL GASTOS HOY: \x1b[31m\x1b[1m${formatNum(sumG)} BOB\x1b[0m`);
    }
    console.log('================================================================================\n');
}

/**
 * 3. Comando: Registro y Consulta de Ingresos / Aportes / Fondos Holdeados
 */
async function handleIncome(args) {
    const today = getTodayStr();
    const ledger = loadLedger();
    if (!ledger[today]) {
        ledger[today] = { date: today, expenses: [], incomes: [] };
    }
    if (!Array.isArray(ledger[today].incomes)) {
        ledger[today].incomes = [];
    }

    const parsed = parseMoneyEntry(args, ['--ingreso', '-i', '--ingresos', '-I'], ['--borrar-ingreso', '--delete-ingreso']);

    if (parsed.isDelete) {
        const idToDelete = parsed.deleteId;
        const prevCount = ledger[today].incomes.length;
        ledger[today].incomes = ledger[today].incomes.filter((item, idx) => item.id !== idToDelete && (idx + 1) !== idToDelete);
        saveLedger(ledger);
        console.log(`\n🗑️ Ingreso/aporte eliminado. Ingresos restantes hoy: ${ledger[today].incomes.length}\n`);
        return;
    }

    if (!parsed.isListing) {
        let rate = ledger[today]?.opening?.rateAvg || ledger[today]?.closing?.rateAvg;
        if (!rate || rate <= 0) {
            try {
                const snap = await fetchLiveFinancialSnapshot({ forceLiveBank: false });
                rate = snap.rates.rateAvg;
            } catch (e) {
                rate = 12.10;
            }
        }

        let amountBob = 0;
        let amountUsdt = 0;

        if (parsed.currency === 'USDT') {
            amountUsdt = parsed.amount;
            amountBob = parseFloat((amountUsdt * rate).toFixed(2));
        } else {
            amountBob = parsed.amount;
            amountUsdt = rate > 0 ? parseFloat((amountBob / rate).toFixed(2)) : 0;
        }

        const entry = {
            id: Date.now(),
            time: getTimeStr(),
            amountBob,
            amountUsdt,
            currency: parsed.currency,
            rateUsed: rate,
            description: parsed.description
        };

        ledger[today].incomes.push(entry);
        saveLedger(ledger);

        const totalIncsBob = ledger[today].incomes.reduce((s, item) => s + item.amountBob, 0);
        const totalIncsUsdt = ledger[today].incomes.reduce((s, item) => s + (item.amountUsdt || 0), 0);

        console.clear();
        console.log('================================================================================');
        console.log(` 📥 INGRESO / FONDO HOLDEADO REGISTRADO [${today}]`);
        console.log('================================================================================');
        console.log(` 🕒 Hora:        ${entry.time}`);
        if (entry.currency === 'USDT') {
            console.log(` 💵 Monto:       \x1b[36m\x1b[1m+${formatNum(entry.amountUsdt)} USDT\x1b[0m  ➔  \x1b[32m\x1b[1m+${formatNum(entry.amountBob)} BOB\x1b[0m (Tasa: ${rate.toFixed(3)})`);
        } else {
            console.log(` 💵 Monto:       \x1b[32m\x1b[1m+${formatNum(entry.amountBob)} BOB\x1b[0m  ➔  \x1b[36m\x1b[1m+${formatNum(entry.amountUsdt)} USDT\x1b[0m (Tasa: ${rate.toFixed(3)})`);
        }
        console.log(` 📝 Descripción: ${entry.description}`);
        console.log('--------------------------------------------------------------------------------');
        console.log(` 📊 TOTAL INGRESOS / HOLD HOY: \x1b[36m\x1b[1m+${formatNum(totalIncsBob)} BOB\x1b[0m (~${formatNum(totalIncsUsdt)} USDT) [${ledger[today].incomes.length} registros]`);
        console.log(' 💡 Nota: Este capital se descontará automáticamente en el cierre y en el stat');
        console.log('    para reflejar exactamente tus ganancias netas de trading sin varianza.');
        console.log('================================================================================\n');
        return;
    }

    // Listar ingresos de hoy
    console.clear();
    console.log('================================================================================');
    console.log(` 📥 INGRESOS / APORTES DE CAPITAL REGISTRADOS HOY [${today}]`);
    console.log('================================================================================');
    const incs = ledger[today].incomes;
    if (incs.length === 0) {
        console.log('   (No hay ingresos ni fondos holdeados registrados hoy)');
    } else {
        incs.forEach((item, i) => {
            const origStr = item.currency === 'USDT'
                ? `+${formatNum(item.amountUsdt)} USDT (~${formatNum(item.amountBob)} BOB)`
                : `+${formatNum(item.amountBob)} BOB (~${formatNum(item.amountUsdt)} USDT)`;
            console.log(` [#${i + 1}] ${item.time} │ \x1b[36m\x1b[1m${origStr.padStart(28, ' ')}\x1b[0m │ ${item.description}`);
        });
        const sumBob = incs.reduce((s, item) => s + item.amountBob, 0);
        const sumUsdt = incs.reduce((s, item) => s + (item.amountUsdt || 0), 0);
        console.log('--------------------------------------------------------------------------------');
        console.log(` 📌 TOTAL INGRESOS / CAPITAL EXTERNO: \x1b[36m\x1b[1m+${formatNum(sumBob)} BOB\x1b[0m (~${formatNum(sumUsdt)} USDT)`);
        console.log(' 💡 Recuerda: Este monto se descuenta de tu cartera final para no inflar las ganancias.');
    }
    console.log('================================================================================\n');
}

/**
 * 4. Comando: Cierre del Día
 */
async function handleCloseDay(args) {
    const today = getTodayStr();
    const ledger = loadLedger();

    if (!ledger[today] || !ledger[today].opening) {
        console.clear();
        console.log('================================================================================');
        console.log(` ⚠️ NO SE ENCONTRÓ APERTURA REGISTRADA PARA HOY [${today}]`);
        console.log('================================================================================');
        console.log('👉 Para realizar el cierre exacto necesitas una apertura.');
        console.log('   Si deseas abrir el día ahora mismo, ejecuta: node ejercicio.js --abrir');
        console.log('   O especifica un capital inicial manual:     node ejercicio.js --cerrar --inicio=MONTO_BOB\n');

        const initialArg = args.find(a => a.startsWith('--inicio=') || a.startsWith('--open='));
        if (!initialArg) return;
        const manualInit = parseFloat(initialArg.split('=')[1]);
        if (!isNaN(manualInit) && manualInit > 0) {
            if (!ledger[today]) ledger[today] = { date: today, expenses: [], incomes: [] };
            ledger[today].opening = {
                timestamp: new Date().toISOString(),
                time: getTimeStr(),
                rateAvg: 12.05,
                bybitUsdt: 0,
                bybitBob: 0,
                binanceUsdt: 0,
                binanceBob: 0,
                bancoSolBob: manualInit,
                totalInitialBob: manualInit,
                totalInitialUsdt: manualInit / 12.05
            };
            console.log(`✅ Registrada apertura manual provisional con ${manualInit} BOB.`);
        } else {
            return;
        }
    }

    const op = ledger[today].opening;
    const exps = ledger[today].expenses || [];
    const incs = ledger[today].incomes || [];
    const totalExpensesBob = exps.reduce((s, e) => s + e.amountBob, 0);
    const totalIncomesBob = incs.reduce((s, i) => s + i.amountBob, 0);

    console.clear();
    console.log('⏳ Sincronizando saldos finales de Bybit, Binance y Banco Sol para el CIERRE...');
    const customSol = parseSolArg(args);
    const shouldQueryLive = !args.includes('--no-live') && customSol === undefined;
    const snap = await fetchLiveFinancialSnapshot({ customSol, forceLiveBank: shouldQueryLive });
    const b = snap.balances;
    const r = snap.rates;

    const totalFinalBob = b.totalCapitalBob;
    const totalInitialBob = op.totalInitialBob;

    // FÓRMULA FINANCIERA EXACTA DE GANANCIA NETA REAL:
    // (Total Fiat Final + Gastos Retirados - Ingresos/Aportes/Hold) - Inicio del Día = Ganancia Neta Real
    const netProfitBob = parseFloat(((totalFinalBob + totalExpensesBob - totalIncomesBob) - totalInitialBob).toFixed(2));
    const roiPercent = totalInitialBob > 0 ? parseFloat(((netProfitBob / totalInitialBob) * 100).toFixed(2)) : 0;

    const closingData = {
        timestamp: snap.timestamp,
        time: snap.timeStr,
        rateAvg: r.rateAvg,
        bybitUsdt: b.bybitUsdt,
        bybitBob: b.bybitBob,
        binanceUsdt: b.binanceUsdt,
        binanceBob: b.binanceBob,
        bancoSolBob: b.bancoSolBob,
        totalFinalBob,
        totalExpensesBob,
        totalIncomesBob,
        totalInitialBob,
        netProfitBob,
        roiPercent
    };

    ledger[today].closing = closingData;
    saveLedger(ledger);

    // Guardar también en CSV para Excel
    appendClosingToCSV({
        date: today,
        openTime: op.time,
        openBob: op.totalInitialBob,
        closeTime: snap.timeStr,
        closeBob: totalFinalBob,
        expensesBob: totalExpensesBob,
        incomesBob: totalIncomesBob,
        profitBob: netProfitBob,
        roiPercent,
        rateAvg: r.rateAvg,
        bybitUsdt: b.bybitUsdt,
        binanceUsdt: b.binanceUsdt,
        bancoSolBob: b.bancoSolBob
    });

    console.clear();
    console.log('================================================================================');
    console.log(` 🌙 ¡CIERRE DIARIO CONSOLIDADO EXITOSAMENTE! [${today} - ${snap.timeStr}]`);
    console.log('================================================================================');
    console.log(` 💱 Tasa Promedio de Cierre:  \x1b[33m\x1b[1m${r.rateAvg.toFixed(3)} BOB/USDT\x1b[0m`);
    console.log('--------------------------------------------------------------------------------');
    console.log(' 💼 SALDOS FINALES AL MOMENTO DEL CIERRE:');
    console.log(`    • Bybit:      ${formatNum(b.bybitUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(b.bybitBob).padStart(11, ' ')} BOB`);
    console.log(`    • Binance:    ${formatNum(b.binanceUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(b.binanceBob).padStart(11, ' ')} BOB`);
    console.log(`    • Banco Sol:                         ${formatNum(b.bancoSolBob).padStart(11, ' ')} BOB`);
    console.log(`    ─────────────────────────────────────────────────────────────`);
    console.log(`    👉 TOTAL FINAL CARTERA (A):         \x1b[36m\x1b[1m${formatNum(totalFinalBob).padStart(11, ' ')} BOB\x1b[0m (~${formatNum(b.totalCapitalUsdt)} USDT)`);
    console.log('--------------------------------------------------------------------------------');
    console.log(' 📊 CÁLCULO DE GANANCIA NETA DEL DÍA:');
    console.log(`    (+) Total Final en Cartera:         +${formatNum(totalFinalBob).padStart(10, ' ')} BOB`);
    console.log(`    (+) Gastos Realizados en el Día:    +${formatNum(totalExpensesBob).padStart(10, ' ')} BOB (${exps.length} gastos anotados)`);
    if (totalIncomesBob > 0) {
        console.log(`    (-) Ingresos / Hold / Inyecciones:  -${formatNum(totalIncomesBob).padStart(10, ' ')} BOB (${incs.length} registros anotados)`);
    }
    console.log(`    (-) Capital Inicial Apertura:       -${formatNum(totalInitialBob).padStart(10, ' ')} BOB (Registrado a las ${op.time})`);
    console.log('    ─────────────────────────────────────────────────────────────');

    const profitColor = netProfitBob >= 0 ? '\x1b[32m\x1b[1m' : '\x1b[31m\x1b[1m';
    const profitSign = netProfitBob >= 0 ? '+' : '';
    const profitUsdt = r.rateAvg > 0 ? parseFloat((netProfitBob / r.rateAvg).toFixed(2)) : 0;
    console.log(`    💰 GANANCIA NETA DEL DÍA:           ${profitColor}${profitSign}${formatNum(netProfitBob)} BOB\x1b[0m (~${profitColor}${profitSign}${formatNum(profitUsdt)} USDT\x1b[0m)`);
    console.log(`    📈 RENDIMIENTO DIARIO (ROI):         ${profitColor}${profitSign}${roiPercent}%\x1b[0m`);
    console.log('================================================================================');
    console.log(` 📁 Cierre archivado en: diario_ledger.json y diario_ledger.csv`);
    console.log(' 👉 Para ver el resumen semanal de tus días, ejecuta: node ejercicio.js --semana\n');
}

/**
 * 5. Comando: Reporte por Rangos y Semanal (Sábados)
 */
function handleRangeReport(args) {
    const ledger = loadLedger();
    const dates = Object.keys(ledger).sort();

    let startDate = null;
    let endDate = null;

    const rangeIdx = args.findIndex(a => a === '--rango' || a === '-r');
    if (rangeIdx !== -1 && args[rangeIdx + 1] && args[rangeIdx + 2]) {
        startDate = args[rangeIdx + 1];
        endDate = args[rangeIdx + 2];
    } else {
        const now = new Date();
        endDate = getTodayStr();
        const past = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000));
        startDate = past.toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' });
    }

    const filteredDates = dates.filter(d => d >= startDate && d <= endDate);

    console.clear();
    console.log('===============================================================================================================');
    console.log(` 📊 REPORTE DE RENDIMIENTO FINANCIERO [Desde: ${startDate}  Hasta: ${endDate}]`);
    console.log('===============================================================================================================');

    if (filteredDates.length === 0) {
        console.log('\n ℹ️ No se encontraron registros de días cerrados en este rango de fechas.');
        console.log('   Usa: node ejercicio.js --abrir y node ejercicio.js --cerrar cada día para alimentar el historial.\n');
        return;
    }

    console.log('┌────────────┬─────────────┬─────────────┬────────────┬─────────────┬──────────────┬──────────┬──────────────┐');
    console.log('│ Fecha      │ Apertura Bs │ Cierre Bs   │ Gastos Bs  │ Ingresos Bs │ Ganancia BOB │ ROI %    │ Tasa Prom Bs │');
    console.log('├────────────┼─────────────┼─────────────┼────────────┼─────────────┼──────────────┼──────────┼──────────────┤');

    let sumInitial = 0;
    let sumFinal = 0;
    let sumExpenses = 0;
    let sumIncomes = 0;
    let sumProfit = 0;
    let daysWithProfit = 0;

    filteredDates.forEach(d => {
        const item = ledger[d];
        const op = item.opening || {};
        const cl = item.closing || {};
        const ex = item.expenses || [];
        const inc = item.incomes || [];

        const openBob = op.totalInitialBob || 0;
        const closeBob = cl.totalFinalBob || (openBob > 0 ? openBob : 0);
        const expBob = cl.totalExpensesBob !== undefined ? cl.totalExpensesBob : ex.reduce((s, e) => s + e.amountBob, 0);
        const incBob = cl.totalIncomesBob !== undefined ? cl.totalIncomesBob : inc.reduce((s, i) => s + i.amountBob, 0);
        const profitBob = cl.netProfitBob !== undefined ? cl.netProfitBob : ((closeBob + expBob - incBob) - openBob);
        const roi = cl.roiPercent !== undefined ? cl.roiPercent : (openBob > 0 ? (profitBob / openBob) * 100 : 0);
        const rate = cl.rateAvg || op.rateAvg || 0;

        sumInitial += openBob;
        sumFinal += closeBob;
        sumExpenses += expBob;
        sumIncomes += incBob;
        sumProfit += profitBob;
        daysWithProfit++;

        const pCol = profitBob >= 0 ? '\x1b[32m' : '\x1b[31m';
        const pSign = profitBob >= 0 ? '+' : '';
        const pStr = `${pCol}${pSign}${formatNum(profitBob).padStart(10, ' ')} Bs\x1b[0m`;
        const roiStr = `${pCol}${pSign}${roi.toFixed(2).padStart(6, ' ')}%\x1b[0m`;

        console.log(`│ ${d} │ ${formatNum(openBob).padStart(11, ' ')} │ ${formatNum(closeBob).padStart(11, ' ')} │ ${formatNum(expBob).padStart(10, ' ')} │ ${formatNum(incBob).padStart(11, ' ')} │ ${pStr} │ ${roiStr} │ ${rate.toFixed(3).padStart(12, ' ')} │`);
    });

    console.log('├────────────┴─────────────┴─────────────┴────────────┴─────────────┴──────────────┴──────────┴──────────────┤');
    const totCol = sumProfit >= 0 ? '\x1b[32m\x1b[1m' : '\x1b[31m\x1b[1m';
    const totSign = sumProfit >= 0 ? '+' : '';
    const avgProfitDay = daysWithProfit > 0 ? (sumProfit / daysWithProfit) : 0;

    console.log(`│ 📌 TOTAL GASTOS DEL PERÍODO:         \x1b[31m\x1b[1m${formatNum(sumExpenses).padStart(12, ' ')} BOB\x1b[0m                                                               │`);
    if (sumIncomes > 0) {
        console.log(`│ 📥 TOTAL INGRESOS / CAPITAL EXTERNO: \x1b[36m\x1b[1m${formatNum(sumIncomes).padStart(12, ' ')} BOB\x1b[0m                                                               │`);
    }
    console.log(`│ 💰 GANANCIA NETA TOTAL ACUMULADA:    ${totCol}${totSign}${formatNum(sumProfit).padStart(12, ' ')} BOB\x1b[0m                                                               │`);
    console.log(`│ 📈 PROMEDIO GANANCIA POR DÍA:        ${totCol}${totSign}${formatNum(avgProfitDay).padStart(12, ' ')} BOB / día\x1b[0m                                                        │`);
    console.log('└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘\n');
}

function parseSolArg(args) {
    let customSol;
    const solEq = args.find(a => a.startsWith('--sol=') || a.startsWith('--bank='));
    if (solEq) {
        customSol = parseFloat(solEq.split('=')[1]);
    } else {
        const solIdx = args.findIndex(a => a === '--sol' || a === '--bank' || a === '-s');
        if (solIdx !== -1 && args[solIdx + 1] && !isNaN(parseFloat(args[solIdx + 1]))) {
            customSol = parseFloat(args[solIdx + 1]);
        }
    }
    if (customSol !== undefined && !isNaN(customSol)) {
        if (fs.existsSync(CAPITAL_FILE)) {
            try {
                const cap = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
                cap.bancoSolBob = customSol;
                fs.writeFileSync(CAPITAL_FILE, JSON.stringify(cap, null, 2), 'utf8');
            } catch (e) {}
        }
        return customSol;
    }
    return undefined;
}

/**
 * 6. Comando: Stat / Estado Hasta Ahora (Apertura vs Cartera Actual vs Gastos/Ingresos)
 */
async function handleStat(args) {
    const today = getTodayStr();
    const ledger = loadLedger();
    const todayItem = ledger[today] || {};
    const opening = todayItem.opening || null;
    const expenses = todayItem.expenses || [];
    const incomes = todayItem.incomes || [];
    const totalExpenses = expenses.reduce((s, e) => s + e.amountBob, 0);
    const totalIncomes = incomes.reduce((s, i) => s + i.amountBob, 0);

    const customSol = parseSolArg(args);
    const shouldQueryLive = !args.includes('--no-live') && !args.includes('--fast') && customSol === undefined;

    console.clear();
    console.log('⏳ Sincronizando saldos en vivo (Bybit, Binance y Banco Sol SolNet Digital)...');
    const snap = await fetchLiveFinancialSnapshot({ customSol, forceLiveBank: shouldQueryLive });
    const b = snap.balances;
    const r = snap.rates;

    console.clear();
    console.log('========================================================================================');
    console.log(` 📊 ESTADO FINANCIERO HASTA AHORA [${today} - ${snap.timeStr}]`);
    console.log('========================================================================================');

    if (!opening) {
        console.log('\n ⚠️ NO SE HA REGISTRADO LA APERTURA DE HOY');
        console.log('   Para medir tu ganancia exacta de hoy, registra tu apertura con:');
        console.log('   👉 npm run ejercicio:abrir\n');
        console.log('----------------------------------------------------------------------------------------');
        console.log(' 💼 SALDOS ACTUALES EN CARTERA:');
        console.log(`    • Bybit:      ${formatNum(b.bybitUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(b.bybitBob).padStart(11, ' ')} BOB`);
        console.log(`    • Binance:    ${formatNum(b.binanceUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(b.binanceBob).padStart(11, ' ')} BOB`);
        console.log(`    • Banco Sol:                         ${formatNum(b.bancoSolBob).padStart(11, ' ')} BOB`);
        console.log('    ────────────────────────────────────────────────────────────');
        console.log(`    👉 TOTAL ACTUAL:                     \x1b[32m\x1b[1m${formatNum(b.totalCapitalBob).padStart(11, ' ')} BOB\x1b[0m (~${formatNum(b.totalCapitalUsdt)} USDT)`);
        console.log('========================================================================================\n');
        return;
    }

    let elapsedStr = '';
    if (opening.timestamp) {
        const diffMs = Math.max(0, new Date().getTime() - new Date(opening.timestamp).getTime());
        const diffMins = Math.floor(diffMs / 60000);
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        elapsedStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    const initialBob = opening.totalInitialBob;
    const currentBob = b.totalCapitalBob;
    const netProfitSoFar = (currentBob + totalExpenses - totalIncomes) - initialBob;
    const roiSoFar = initialBob > 0 ? (netProfitSoFar / initialBob) * 100 : 0;

    const profitColor = netProfitSoFar >= 0 ? '\x1b[32m\x1b[1m' : '\x1b[31m\x1b[1m';
    const profitSign = netProfitSoFar >= 0 ? '+' : '';
    const profitUsdt = r.rateAvg > 0 ? parseFloat((netProfitSoFar / r.rateAvg).toFixed(2)) : 0;

    console.log(` 🌅 1. APERTURA (Inicio del Día a las ${opening.time}${elapsedStr ? ` · Hace ${elapsedStr}` : ''}):`);
    console.log(`    • Bybit:      ${formatNum(opening.bybitUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(opening.bybitBob).padStart(11, ' ')} BOB`);
    console.log(`    • Binance:    ${formatNum(opening.binanceUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(opening.binanceBob).padStart(11, ' ')} BOB`);
    console.log(`    • Banco Sol:                         ${formatNum(opening.bancoSolBob).padStart(11, ' ')} BOB`);
    console.log(`    💱 Tasa Apertura: ${opening.rateAvg.toFixed(3)} BOB/USDT`);
    console.log('    ────────────────────────────────────────────────────────────');
    console.log(`    👉 TOTAL INICIAL APERTURA:           \x1b[33m\x1b[1m${formatNum(initialBob).padStart(11, ' ')} BOB\x1b[0m (~${formatNum(opening.totalInitialUsdt)} USDT)`);
    console.log('----------------------------------------------------------------------------------------');

    console.log(` 💼 2. CARTERA ACTUAL HASTA AHORA (a las ${snap.timeStr}):`);
    console.log(`    • Bybit:      ${formatNum(b.bybitUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(b.bybitBob).padStart(11, ' ')} BOB`);
    console.log(`    • Binance:    ${formatNum(b.binanceUsdt).padStart(9, ' ')} USDT  ➔  ${formatNum(b.binanceBob).padStart(11, ' ')} BOB`);
    console.log(`    • Banco Sol:                         ${formatNum(b.bancoSolBob).padStart(11, ' ')} BOB`);
    console.log(`    💱 Tasa Actual Mercado: \x1b[36m${r.rateAvg.toFixed(3)} BOB/USDT\x1b[0m (Bybit: ${r.bybitBuy.toFixed(3)}/${r.bybitSell.toFixed(3)} │ Binance: ${r.binanceBuy.toFixed(3)}/${r.binanceSell.toFixed(3)})`);
    console.log('    ────────────────────────────────────────────────────────────');
    console.log(`    👉 TOTAL CARTERA ACTUAL:             \x1b[36m\x1b[1m${formatNum(currentBob).padStart(11, ' ')} BOB\x1b[0m (~${formatNum(b.totalCapitalUsdt)} USDT)`);
    console.log('----------------------------------------------------------------------------------------');

    let sectionNum = 3;
    if (incomes.length > 0) {
        console.log(` 📥 ${sectionNum}. INGRESOS / CAPITAL EXTERNO / HOLD:   \x1b[36m\x1b[1m+${formatNum(totalIncomes).padStart(11, ' ')} BOB\x1b[0m (${incomes.length} ingresos anotados)`);
        incomes.forEach((item, idx) => {
            const origStr = item.currency === 'USDT' ? `+${formatNum(item.amountUsdt)} USDT (~${formatNum(item.amountBob)} BOB)` : `+${formatNum(item.amountBob)} BOB`;
            console.log(`       [#${idx + 1}] ${item.time} │ ${origStr} │ ${item.description}`);
        });
        console.log('----------------------------------------------------------------------------------------');
        sectionNum++;
    }

    console.log(` 💸 ${sectionNum}. GASTOS REGISTRADOS HOY:            \x1b[31m\x1b[1m-${formatNum(totalExpenses).padStart(11, ' ')} BOB\x1b[0m (${expenses.length} gastos anotados)`);
    if (expenses.length > 0) {
        expenses.forEach((e, idx) => {
            const origStr = e.currency === 'USDT' ? `-${formatNum(e.amountUsdt)} USDT (~${formatNum(e.amountBob)} BOB)` : `-${formatNum(e.amountBob)} BOB`;
            console.log(`       [#${idx + 1}] ${e.time} │ ${origStr} │ ${e.description}`);
        });
    }
    console.log('========================================================================================');
    sectionNum++;

    console.log(` 📈 ${sectionNum}. BALANCE Y GANANCIA NETA HASTA AHORA:`);
    console.log(`    (+) Cartera Actual en Vivo:          +${formatNum(currentBob).padStart(10, ' ')} BOB`);
    console.log(`    (+) Gastos Realizados en el Día:     +${formatNum(totalExpenses).padStart(10, ' ')} BOB`);
    if (totalIncomes > 0) {
        console.log(`    (-) Ingresos / Hold / Aportes:       -${formatNum(totalIncomes).padStart(10, ' ')} BOB (Descontados de ganancia)`);
    }
    console.log(`    (-) Capital Inicial Apertura:        -${formatNum(initialBob).padStart(10, ' ')} BOB`);
    console.log('    ────────────────────────────────────────────────────────────');
    console.log(`    💰 GANANCIA NETA HASTA AHORA:        ${profitColor}${profitSign}${formatNum(netProfitSoFar).padStart(10, ' ')} BOB\x1b[0m (~${profitColor}${profitSign}${formatNum(profitUsdt)} USDT\x1b[0m)`);
    console.log(`    🎯 RENDIMIENTO EN CURSO (ROI):       ${profitColor}${profitSign}${roiSoFar.toFixed(2)}%\x1b[0m`);
    console.log('========================================================================================\n');
}

/**
 * Bucle / Vista Principal en Vivo de Hoy
 */
async function runEjercicio() {
    const args = process.argv.slice(2);

    // Rutas de comandos especializados
    if (args.includes('--stat') || args.includes('--stats') || args.includes('--status') || args.includes('-s')) {
        await handleStat(args);
        return;
    }

    if (args.includes('--abrir') || args.includes('--inicio') || args.includes('--open')) {
        await handleOpenDay(args);
        return;
    }

    if (args.includes('--cerrar') || args.includes('--cierre') || args.includes('--close')) {
        await handleCloseDay(args);
        return;
    }

    if (args.includes('--gasto') || args.includes('-g') || args.includes('--gastos') || args.includes('-G') || args.includes('--borrar-gasto')) {
        await handleExpense(args);
        return;
    }

    if (args.includes('--ingreso') || args.includes('-i') || args.includes('--ingresos') || args.includes('-I') || args.includes('--borrar-ingreso')) {
        await handleIncome(args);
        return;
    }

    if (args.includes('--semana') || args.includes('--week') || args.includes('--rango') || args.includes('-r')) {
        handleRangeReport(args);
        return;
    }

    // VISTA DE AUDITORÍA EN TIEMPO REAL DE HOY:
    const today = getTodayStr();
    const ledger = loadLedger();
    const todayItem = ledger[today] || {};
    const opening = todayItem.opening || null;
    const expenses = todayItem.expenses || [];
    const incomes = todayItem.incomes || [];
    const totalExpenses = expenses.reduce((s, e) => s + e.amountBob, 0);
    const totalIncomes = incomes.reduce((s, i) => s + i.amountBob, 0);

    console.clear();
    console.log('================================================================================================');
    console.log(` 📊 AUDITORÍA Y EJERCICIO FINANCIERO EN TIEMPO REAL [${today}]`);
    console.log('================================================================================================\n');

    // 1. ESTADO DE APERTURA DEL DÍA
    if (opening) {
        console.log(` 🌅 ESTADO APERTURA: \x1b[32m\x1b[1mINICIADO\x1b[0m a las ${opening.time} │ Capital Inicial: \x1b[32m\x1b[1m${formatNum(opening.totalInitialBob)} BOB\x1b[0m (~${formatNum(opening.totalInitialUsdt)} USDT)`);
    } else {
        console.log(` 🌅 ESTADO APERTURA: \x1b[33m\x1b[1mPENDIENTE DE APERTURA\x1b[0m (👉 Inicia con: npm run ejercicio:abrir)`);
    }
    console.log(` 💸 GASTOS ANOTADOS HOY: \x1b[31m\x1b[1m${formatNum(totalExpenses)} BOB\x1b[0m (${expenses.length} registros)`);
    if (totalIncomes > 0) {
        console.log(` 📥 INGRESOS / HOLD HOY: \x1b[36m\x1b[1m+${formatNum(totalIncomes)} BOB\x1b[0m (${incomes.length} registros)`);
    }
    console.log('------------------------------------------------------------------------------------------------');

    // 2. CONSULTAR SALDOS EN VIVO Y MERCADO
    console.log('⏳ Sincronizando saldos en vivo (Bybit, Binance, Banco Sol vía SolNet) y cotización...');
    const customSol = parseSolArg(args);
    const shouldQueryLive = !args.includes('--no-live') && !args.includes('--fast') && customSol === undefined;
    const snap = await fetchLiveFinancialSnapshot({ customSol, forceLiveBank: shouldQueryLive });
    const b = snap.balances;
    const r = snap.rates;

    console.clear();
    console.log('================================================================================================');
    console.log(` 📊 AUDITORÍA Y EJERCICIO FINANCIERO EN TIEMPO REAL [${today} - ${snap.timeStr}]`);
    console.log('================================================================================================');
    if (opening) {
        console.log(` 🌅 APERTURA REGISTRADA: ${opening.time}  ➔  Capital Inicial: \x1b[32m\x1b[1m${formatNum(opening.totalInitialBob)} BOB\x1b[0m`);
    } else {
        console.log(` 🌅 APERTURA REGISTRADA: \x1b[33m\x1b[1mPENDIENTE\x1b[0m  (👉 Registra tu inicio con: npm run ejercicio:abrir)`);
    }
    console.log(` 💸 GASTOS DEL DÍA:      \x1b[31m\x1b[1m${formatNum(totalExpenses)} BOB\x1b[0m`);
    if (totalIncomes > 0) {
        console.log(` 📥 INGRESOS / HOLD:     \x1b[36m\x1b[1m+${formatNum(totalIncomes)} BOB\x1b[0m`);
    }
    console.log(` 💱 CAMBIO PROMEDIO HOY: \x1b[33m\x1b[1m${r.rateAvg.toFixed(3)} BOB/USDT\x1b[0m  (Bybit: ${r.bybitBuy.toFixed(3)}/${r.bybitSell.toFixed(3)} │ Binance: ${r.binanceBuy.toFixed(3)}/${r.binanceSell.toFixed(3)})`);
    console.log('------------------------------------------------------------------------------------------------');

    // 3. DESGLOSE DE CAPITAL EN VIVO
    console.log(' 💼 CARTERA CONSOLIDADA EN VIVO:');
    console.log(`    • Bybit (Fondos/Spot):     ${formatNum(b.bybitUsdt).padStart(9, ' ')} USDT  ➔  \x1b[36m\x1b[1m${formatNum(b.bybitBob).padStart(12, ' ')} BOB\x1b[0m`);
    console.log(`    • Binance (Fondos/Spot):   ${formatNum(b.binanceUsdt).padStart(9, ' ')} USDT  ➔  \x1b[36m\x1b[1m${formatNum(b.binanceBob).padStart(12, ' ')} BOB\x1b[0m`);
    console.log(`    • Banco Sol (Cuenta BOB):                   \x1b[32m\x1b[1m${formatNum(b.bancoSolBob).padStart(12, ' ')} BOB\x1b[0m`);
    console.log('    ────────────────────────────────────────────────────────────');
    console.log(`    👉 TOTAL CAPITAL ACTUAL:   \x1b[32m\x1b[1m${formatNum(b.totalCapitalBob).padStart(12, ' ')} BOB\x1b[0m  │  \x1b[36m${formatNum(b.totalCapitalUsdt)} USDT\x1b[0m`);

    // 4. GANANCIA EN CURSO (SI HAY APERTURA)
    if (opening) {
        const liveNetProfit = (b.totalCapitalBob + totalExpenses - totalIncomes) - opening.totalInitialBob;
        const liveRoi = opening.totalInitialBob > 0 ? (liveNetProfit / opening.totalInitialBob) * 100 : 0;
        const col = liveNetProfit >= 0 ? '\x1b[32m\x1b[1m' : '\x1b[31m\x1b[1m';
        const sgn = liveNetProfit >= 0 ? '+' : '';
        const liveProfitUsdt = r.rateAvg > 0 ? parseFloat((liveNetProfit / r.rateAvg).toFixed(2)) : 0;

        console.log('------------------------------------------------------------------------------------------------');
        console.log(' 📈 ESTIMACIÓN DE GANANCIA EN CURSO (En vivo vs Apertura):');
        const incFormulaPart = totalIncomes > 0 ? ` - ${formatNum(totalIncomes)} Ingresos` : '';
        console.log(`    Fórmula: (${formatNum(b.totalCapitalBob)} Actual + ${formatNum(totalExpenses)} Gastos${incFormulaPart}) - ${formatNum(opening.totalInitialBob)} Inicio`);
        console.log(`    💰 GANANCIA NETA PROVISIONAL:  ${col}${sgn}${formatNum(liveNetProfit)} BOB (${sgn}${liveRoi.toFixed(2)}%)\x1b[0m  │  ~${col}${sgn}${formatNum(liveProfitUsdt)} USDT\x1b[0m`);
    }

    // 5. ÓRDENES DEL DÍA
    const history = loadHistory();
    const todayOrders = history.filter(r => (r.date || '').startsWith(today) || (r.timestamp || '').startsWith(today));
    const validOrders = todayOrders.filter(r => !(r.status || '').toUpperCase().includes('CANCEL'));
    const compras = validOrders.filter(r => (r.type || '').toUpperCase() === 'COMPRA');
    const ventas = validOrders.filter(r => (r.type || '').toUpperCase() === 'VENTA');

    if (validOrders.length > 0) {
        console.log('------------------------------------------------------------------------------------------------');
        console.log(` 📋 ÓRDENES EJECUTADAS HOY: ${validOrders.length} (${compras.length} compras │ ${ventas.length} ventas)`);
        const sumBuyUsdt = compras.reduce((s, c) => s + parseFloat(c.cryptoAmount || 0), 0);
        const sumBuyBob = compras.reduce((s, c) => s + (parseFloat(c.cryptoAmount || 0) * parseFloat(c.price || 0)), 0);
        const sumSellUsdt = ventas.reduce((s, v) => s + parseFloat(v.cryptoAmount || 0), 0);
        const sumSellBob = ventas.reduce((s, v) => s + (parseFloat(v.cryptoAmount || 0) * parseFloat(v.price || 0)), 0);

        if (compras.length > 0) console.log(`    🟢 Compras: ${formatNum(sumBuyUsdt)} USDT  ➔  ${formatNum(sumBuyBob)} BOB pagados`);
        if (ventas.length > 0)  console.log(`    🔴 Ventas:  ${formatNum(sumSellUsdt)} USDT  ➔  ${formatNum(sumSellBob)} BOB recibidos`);
    }

    console.log('================================================================================================');
    console.log(' ⌨️  COMANDOS DISPONIBLES:');
    console.log('    • [npm run ejercicio:stat]                        Ver Balance y Ganancia Hasta Ahora');
    console.log('    • [npm run ejercicio:abrir]                       Registrar Inicio del Día');
    console.log('    • [npm run ejercicio:gasto -- 50 "Comida"]        Anotar un gasto del día');
    console.log('    • [npm run ejercicio:gastos]                      Ver lista de gastos de hoy');
    console.log('    • [npm run ejercicio:ingreso -- 129 $ "Hold"]     Anotar ingreso / fondos holdeados');
    console.log('    • [npm run ejercicio:ingresos]                    Ver lista de ingresos/hold de hoy');
    console.log('    • [npm run ejercicio:cerrar]                      Realizar Cierre Diario');
    console.log('    • [npm run ejercicio:semana]                      Ver reporte consolidado');
    console.log('================================================================================================\n');
}

if (require.main === module) {
    runEjercicio().catch(err => console.error('Error en ejercicio:', err));
}

module.exports = {
    runEjercicio,
    fetchLiveFinancialSnapshot,
    handleOpenDay,
    handleCloseDay,
    handleExpense,
    handleIncome,
    handleRangeReport,
    handleStat
};
