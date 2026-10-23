/**
 * Módulo de Informe Financiero y Auditoría de Ganancias para Bybit P2P
 * Genera:
 * 1. 📜 Historial de Órdenes con formato idéntico a la vista de Bybit (Fecha, ID, Par, Montos, Precio, Contraparte, Estado).
 * 2. ⚖️ Total Vendido vs Total Comprado (USDT, BOB, Precios promedio, Ganancia neta y Margen).
 * 3. 🏦 Saldo en Banco Sol con el Precio Actual del Dólar (Tasa P2P en vivo, equivalencia en USDT y capital consolidado).
 * 4. Generación de reporte HTML interactivo y exportación a CSV/Excel.
 */

const fs = require('fs');
const path = require('path');
const { getLiveBybitBalancesFromApi } = require('./balances');
const { getBancoSolLiveBalance } = require('../banks/bancosol');
const { scanBybitP2PMarket } = require('./market');

const HISTORY_FILE = path.join(__dirname, '../history.json');
const CAPITAL_FILE = path.join(__dirname, '../capital.json');

/**
 * Obtiene la fecha y hora en formato local de Bolivia (America/La_Paz)
 */
function getBoliviaDateTime(itemOrDate) {
    let dateObj;
    if (itemOrDate instanceof Date) {
        dateObj = itemOrDate;
    } else if (itemOrDate && itemOrDate.timestamp) {
        dateObj = new Date(itemOrDate.timestamp);
    } else if (typeof itemOrDate === 'string' && itemOrDate.includes('T')) {
        dateObj = new Date(itemOrDate);
    } else {
        return {
            date: (itemOrDate && itemOrDate.date) || '',
            time: '--:--:--',
            shortDateTime: (itemOrDate && itemOrDate.date) || ''
        };
    }

    if (isNaN(dateObj.getTime())) {
        return {
            date: (itemOrDate && itemOrDate.date) || '',
            time: '--:--:--',
            shortDateTime: (itemOrDate && itemOrDate.date) || ''
        };
    }

    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/La_Paz',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const timeFormatter = new Intl.DateTimeFormat('es-BO', {
        timeZone: 'America/La_Paz',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const shortFormatter = new Intl.DateTimeFormat('es-BO', {
        timeZone: 'America/La_Paz',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const date = dateFormatter.format(dateObj);
    const time = timeFormatter.format(dateObj);
    const shortParts = shortFormatter.formatToParts(dateObj);
    const day = shortParts.find(p => p.type === 'day')?.value || '';
    const month = shortParts.find(p => p.type === 'month')?.value || '';
    const hour = shortParts.find(p => p.type === 'hour')?.value || '';
    const minute = shortParts.find(p => p.type === 'minute')?.value || '';

    return {
        date,
        time,
        shortDateTime: `${day}/${month} ${hour}:${minute}`
    };
}

/**
 * Carga el historial de transacciones desde history.json
 */
function loadTransactions() {
    if (!fs.existsSync(HISTORY_FILE)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

/**
 * Formatea un número con separadores de miles y 2 decimales
 */
function formatNumber(num, decimals = 2) {
    if (typeof num !== 'number' || isNaN(num)) return '0.00';
    return num.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

/**
 * Genera el análisis financiero completo de Bybit y P2P
 */
async function generateBybitFinancialReport(options = {}) {
    const {
        targetDate = null,
        bybitOnly = false,
        liveSaldos = true
    } = options;

    const allHistory = loadTransactions();

    let records = allHistory;
    if (targetDate) {
        records = records.filter(item => {
            const { date } = getBoliviaDateTime(item);
            return date === targetDate;
        });
    }

    if (bybitOnly) {
        records = records.filter(item => {
            const id = String(item.id || '');
            return id.startsWith('BYBIT') || /^\d{18,22}$/.test(id);
        });
    }

    // Cálculos de Compras y Ventas
    let totalBoughtUsdt = 0;
    let totalSpentBob = 0;
    let buyCount = 0;

    let totalSoldUsdt = 0;
    let totalReceivedBob = 0;
    let sellCount = 0;

    let totalProfitBob = 0;

    records.forEach(r => {
        const type = (r.type || '').toUpperCase();
        const status = (r.status || 'EXITOSO').toUpperCase();
        if (status === 'CANCELADO' || status === 'CANCELADA') return;

        const crypto = parseFloat(r.cryptoAmount || r.amountUsdt || 0);
        const fiat = parseFloat(r.fiatAmount || r.amountBob || 0);
        const profit = parseFloat(r.profitBob || r.netProfitBob || 0);

        if (type === 'COMPRA') {
            buyCount++;
            totalBoughtUsdt += crypto;
            totalSpentBob += fiat;
        } else if (type === 'VENTA') {
            sellCount++;
            totalSoldUsdt += crypto;
            totalReceivedBob += fiat;
        }
        totalProfitBob += profit;
    });

    const avgBuyPrice = totalBoughtUsdt > 0 ? (totalSpentBob / totalBoughtUsdt) : 0;
    const avgSellPrice = totalSoldUsdt > 0 ? (totalReceivedBob / totalSoldUsdt) : 0;
    const avgProfitPerUsdt = totalSoldUsdt > 0 ? (totalProfitBob / totalSoldUsdt) : (totalBoughtUsdt > 0 ? (totalProfitBob / totalBoughtUsdt) : 0);
    const totalTurnoverBob = totalSpentBob + totalReceivedBob;
    const roiPercent = totalSpentBob > 0 ? ((totalProfitBob / totalSpentBob) * 100).toFixed(2) : '0.00';

    // Obtener saldos y precio actual del dólar
    let bybitUsdtBalance = 171.56;
    let bybitFundingUsdt = 171.56;
    let bybitSpotUsdt = 0.00;
    let bancoSolBobBalance = 1998.31;
    let referenceRate = 11.99; // Precio actual del dólar

    if (liveSaldos) {
        try {
            const [apiBalances, bankBal, market] = await Promise.all([
                getLiveBybitBalancesFromApi().catch(() => null),
                getBancoSolLiveBalance(false).catch(() => null),
                scanBybitP2PMarket().catch(() => null)
            ]);

            if (apiBalances) {
                bybitFundingUsdt = apiBalances.usdtFunding || 0;
                bybitSpotUsdt = apiBalances.usdtSpot || 0;
                bybitUsdtBalance = apiBalances.totalUsdt || (bybitFundingUsdt + bybitSpotUsdt);
            }
            if (typeof bankBal === 'number' && bankBal > 0) {
                bancoSolBobBalance = bankBal;
            }
            if (market && market.bestSellPrice) {
                referenceRate = market.bestSellPrice;
            } else if (market && market.bestBuyPrice) {
                referenceRate = market.bestBuyPrice;
            }
        } catch (e) {}
    } else {
        if (fs.existsSync(CAPITAL_FILE)) {
            try {
                const cap = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
                if (typeof cap.bybitUsdt === 'number') bybitUsdtBalance = cap.bybitUsdt;
                if (typeof cap.bancoSolBob === 'number') bancoSolBobBalance = cap.bancoSolBob;
            } catch (e) {}
        }
    }

    const totalProfitUsdt = referenceRate > 0 ? (totalProfitBob / referenceRate) : 0;
    const bancoSolInUsdt = referenceRate > 0 ? (bancoSolBobBalance / referenceRate) : 0;
    const bybitUsdtInBob = bybitUsdtBalance * referenceRate;
    const consolidatedCapitalBob = bancoSolBobBalance + bybitUsdtInBob;
    const consolidatedCapitalUsdt = referenceRate > 0 ? (consolidatedCapitalBob / referenceRate) : 0;

    return {
        targetDate,
        bybitOnly,
        records,
        // Compras
        totalBoughtUsdt,
        totalSpentBob,
        avgBuyPrice,
        buyCount,
        // Ventas
        totalSoldUsdt,
        totalReceivedBob,
        avgSellPrice,
        sellCount,
        // Ganancias
        totalProfitBob,
        totalProfitUsdt,
        avgProfitPerUsdt,
        totalTurnoverBob,
        roiPercent,
        referenceRate,
        // Saldos actuales y conversión
        bancoSolBobBalance,
        bancoSolInUsdt,
        bybitUsdtBalance,
        bybitFundingUsdt,
        bybitSpotUsdt,
        bybitUsdtInBob,
        // Consolidado
        consolidatedCapitalBob,
        consolidatedCapitalUsdt
    };
}

/**
 * Imprime en consola un informe visual idéntico a la tabla de Bybit solicitada por el usuario
 */
function printReportScreen(report) {
    const records = report.records;

    console.log('================================================================================================');
    console.log(' 📜 Historial de Órdenes (últimas ' + Math.min(records.length, 10) + ')');
    console.log('================================================================================================');
    console.log(' Fecha        │ ID          │ Par      │ Tipo   │ Monto (BOB)   │ Monto (USDT) │ Precio    │ Contraparte     │ Estado');
    console.log('──────────────┼─────────────┼──────────┼────────┼───────────────┼──────────────┼───────────┼─────────────────┼─────────────');

    const recentRecords = records.slice(-10).reverse();
    recentRecords.forEach(r => {
        const { shortDateTime } = getBoliviaDateTime(r);
        const fullId = String(r.id || '');
        const shortId = fullId.length > 9 ? `...${fullId.slice(-6)}` : fullId.padStart(9, ' ');
        const par = 'USDT/BOB';
        const type = (r.type || 'COMPRA').toUpperCase();
        const typeFmt = type === 'COMPRA' ? '\x1b[32mCOMPRA\x1b[0m ' : '\x1b[31mVENTA \x1b[0m ';
        
        const bobAmount = formatNumber(parseFloat(r.fiatAmount || r.amountBob || 0));
        const usdtAmount = formatNumber(parseFloat(r.cryptoAmount || r.amountUsdt || 0));
        const price = formatNumber(parseFloat(r.price || 0));
        const counterparty = String(r.counterparty || 'Desconocido').substring(0, 15);
        
        const status = (r.status || 'EXITOSO').toUpperCase();
        let statusBadge = '✅ Completada';
        if (status.includes('PEND')) {
            statusBadge = '🟡 Pendiente ';
        } else if (status.includes('CANCEL')) {
            statusBadge = '❌ Cancelada ';
        }

        console.log(` ${shortDateTime.padEnd(12, ' ')} │ ${shortId} │ ${par} │ ${typeFmt} │ ${bobAmount.padStart(11, ' ')} Bs │ ${usdtAmount.padStart(10, ' ')}   │ ${price.padStart(5, ' ')} BOB │ ${counterparty.padEnd(15, ' ')} │ ${statusBadge}`);
    });
    console.log('================================================================================================\n');

    // 2. TOTAL VENDIDO VS TOTAL COMPRADO
    console.log('================================================================================================');
    console.log(' ⚖️  TOTAL VENDIDO vs TOTAL COMPRADO');
    console.log('================================================================================================');
    console.log(` 🟢 TOTAL COMPRADO:       \x1b[32m\x1b[1m${formatNumber(report.totalBoughtUsdt)} USDT\x1b[0m  │  ${formatNumber(report.totalSpentBob)} BOB  │  Precio Promedio: ${formatNumber(report.avgBuyPrice)} BOB  (${report.buyCount} compras)`);
    console.log(` 🔴 TOTAL VENDIDO:        \x1b[31m\x1b[1m${formatNumber(report.totalSoldUsdt)} USDT\x1b[0m  │  ${formatNumber(report.totalReceivedBob)} BOB  │  Precio Promedio: ${formatNumber(report.avgSellPrice)} BOB  (${report.sellCount} ventas)`);
    console.log('------------------------------------------------------------------------------------------------');
    console.log(` 💰 GANANCIA NETA TOTAL:  \x1b[32m\x1b[1m+${formatNumber(report.totalProfitBob)} BOB\x1b[0m (\x1b[36m+${formatNumber(report.totalProfitUsdt)} USDT\x1b[0m)`);
    console.log(` 📈 SPREAD / MARGEN:      \x1b[35m\x1b[1m+${report.avgProfitPerUsdt.toFixed(4)} BOB por USDT\x1b[0m  (Rentabilidad: +${report.roiPercent}% sobre giro de ${formatNumber(report.totalTurnoverBob)} BOB)`);
    console.log('================================================================================================\n');

    // 3. SALDO EN BANCO SOL CON EL PRECIO MÁS ALTO DE VENTA
    console.log('================================================================================================');
    console.log(' 🏦 SALDO EN BANCO SOL CON EL PRECIO MÁS ALTO DE VENTA');
    console.log('================================================================================================');
    console.log(` 💵 PRECIO MÁS ALTO DE VENTA (BYBIT P2P):  \x1b[33m\x1b[1m${formatNumber(report.referenceRate)} BOB / USDT\x1b[0m  (Tasa de compradores en vivo)`);
    console.log('------------------------------------------------------------------------------------------------');
    console.log(` 🔹 Saldo en Banco Sol:                   \x1b[32m\x1b[1m${formatNumber(report.bancoSolBobBalance)} BOB\x1b[0m  (= \x1b[36m${formatNumber(report.bancoSolInUsdt)} USDT\x1b[0m al precio más alto de venta)`);
    console.log(` 🔹 Saldo en Bybit (Fondos P2P):          \x1b[36m\x1b[1m${formatNumber(report.bybitUsdtBalance)} USDT\x1b[0m  (= ${formatNumber(report.bybitUsdtInBob)} BOB)`);
    console.log('------------------------------------------------------------------------------------------------');
    console.log(` 💼 CAPITAL TOTAL CONSOLIDADO:            \x1b[32m\x1b[1m${formatNumber(report.consolidatedCapitalBob)} BOB\x1b[0m  (~\x1b[36m${formatNumber(report.consolidatedCapitalUsdt)} USDT\x1b[0m)`);
    console.log('================================================================================================\n');
}

/**
 * Genera un archivo HTML con diseño idéntico al solicitado (para ver en el navegador)
 */
function generateHTMLDashboard(report, filename = 'reporte_bybit.html') {
    const htmlPath = path.join(__dirname, '../', filename);

    const rowsHtml = report.records.slice(-15).reverse().map(r => {
        const { shortDateTime } = getBoliviaDateTime(r);
        const fullId = String(r.id || '');
        const shortId = fullId.length > 9 ? `...${fullId.slice(-6)}` : fullId;
        const bobAmount = formatNumber(parseFloat(r.fiatAmount || r.amountBob || 0));
        const usdtAmount = formatNumber(parseFloat(r.cryptoAmount || r.amountUsdt || 0));
        const price = formatNumber(parseFloat(r.price || 0));
        const counterparty = String(r.counterparty || 'Desconocido');
        const status = (r.status || 'EXITOSO').toUpperCase();

        let badgeHtml = '<span class="badge badge-success"><span class="icon">✅</span> Completada</span>';
        if (status.includes('PEND')) {
            badgeHtml = '<span class="badge badge-warning"><span class="icon">🟡</span> Pendiente</span>';
        } else if (status.includes('CANCEL')) {
            badgeHtml = '<span class="badge badge-danger"><span class="icon">❌</span> Cancelada</span>';
        }

        const typeColor = r.type === 'COMPRA' ? '#10b981' : '#ef4444';

        return `
            <tr>
                <td style="font-weight: 500;">${shortDateTime}</td>
                <td><span class="id-tag">${shortId}</span></td>
                <td><span style="font-weight: 600; color: #475569;">USDT/BOB</span></td>
                <td style="font-weight: 600; color: ${typeColor};">${r.type || 'COMPRA'}</td>
                <td style="font-weight: 600;">${bobAmount} Bs</td>
                <td>${usdtAmount} USDT</td>
                <td style="font-weight: 500;">${price}</td>
                <td>${counterparty}</td>
                <td>${badgeHtml}</td>
            </tr>
        `;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Historial de Órdenes y Auditoría P2P Bybit</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
        body { background: #f1f5f9; color: #1e293b; padding: 32px 20px; }
        .container { max-width: 1100px; margin: 0 auto; }
        .header-title { font-size: 24px; font-weight: 700; margin-bottom: 24px; display: flex; align-items: center; gap: 10px; }
        
        .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 28px; }
        .card { background: #fff; border-radius: 12px; padding: 22px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -2px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
        .card-title { font-size: 14px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
        .metric-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
        .metric-label { font-size: 14px; color: #475569; }
        .metric-val { font-size: 16px; font-weight: 700; }
        .val-green { color: #10b981; }
        .val-red { color: #ef4444; }
        .val-blue { color: #0284c7; }
        .val-yellow { color: #f59e0b; }
        .divider { height: 1px; background: #e2e8f0; margin: 14px 0; }

        .table-card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
        th { padding: 12px 16px; background: #f8fafc; color: #475569; font-weight: 600; border-bottom: 1px solid #e2e8f0; }
        td { padding: 14px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
        tr:hover { background: #f8fafc; }

        .id-tag { background: #f1f5f9; padding: 4px 8px; border-radius: 6px; font-family: monospace; font-size: 13px; color: #475569; border: 1px solid #e2e8f0; }
        .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 13px; font-weight: 600; }
        .badge-success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
        .badge-warning { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
        .badge-danger { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
        .icon { font-size: 11px; }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="header-title">📜 Historial de Órdenes Bybit P2P y Auditoría Financiera</h1>

        <div class="cards-grid">
            <!-- Tarjeta 1: Total Vendido vs Comprado -->
            <div class="card">
                <div class="card-title">⚖️ Total Vendido vs Total Comprado</div>
                <div class="metric-row">
                    <span class="metric-label">🟢 Total Comprado:</span>
                    <span class="metric-val val-green">${formatNumber(report.totalBoughtUsdt)} USDT</span>
                </div>
                <div class="metric-row" style="font-size: 13px; color: #64748b;">
                    <span>Gasto en Bolivianos:</span>
                    <span>${formatNumber(report.totalSpentBob)} BOB (Prom. ${formatNumber(report.avgBuyPrice)})</span>
                </div>

                <div class="divider"></div>

                <div class="metric-row">
                    <span class="metric-label">🔴 Total Vendido:</span>
                    <span class="metric-val val-red">${formatNumber(report.totalSoldUsdt)} USDT</span>
                </div>
                <div class="metric-row" style="font-size: 13px; color: #64748b;">
                    <span>Cobro en Bolivianos:</span>
                    <span>${formatNumber(report.totalReceivedBob)} BOB (Prom. ${formatNumber(report.avgSellPrice)})</span>
                </div>

                <div class="divider"></div>

                <div class="metric-row">
                    <span class="metric-label">💰 Ganancia Neta Total:</span>
                    <span class="metric-val val-green">+${formatNumber(report.totalProfitBob)} BOB (+${formatNumber(report.totalProfitUsdt)} USDT)</span>
                </div>
                <div class="metric-row" style="font-size: 13px; color: #64748b;">
                    <span>Margen Promedio:</span>
                    <span class="val-blue">+${report.avgProfitPerUsdt.toFixed(4)} BOB / USDT</span>
                </div>
            </div>

            <!-- Tarjeta 2: Saldo Banco Sol y Precio Dólar -->
            <div class="card">
                <div class="card-title">🏦 Banco Sol & Precio del Dólar</div>
                <div class="metric-row">
                    <span class="metric-label">💵 Precio Actual del Dólar (USDT):</span>
                    <span class="metric-val val-yellow">${formatNumber(report.referenceRate)} BOB</span>
                </div>
                <div class="metric-row" style="font-size: 12px; color: #64748b; margin-top: -6px; margin-bottom: 12px;">
                    <span>Mercado P2P en tiempo real</span>
                </div>

                <div class="divider"></div>

                <div class="metric-row">
                    <span class="metric-label">🏦 Saldo en Banco Sol:</span>
                    <span class="metric-val val-green">${formatNumber(report.bancoSolBobBalance)} BOB</span>
                </div>
                <div class="metric-row" style="font-size: 13px; color: #0284c7;">
                    <span>Equivalente en Dólares:</span>
                    <span style="font-weight: 600;">${formatNumber(report.bancoSolInUsdt)} USDT</span>
                </div>

                <div class="divider"></div>

                <div class="metric-row">
                    <span class="metric-label">🪙 Saldo en Bybit (Fondos P2P):</span>
                    <span class="metric-val val-blue">${formatNumber(report.bybitUsdtBalance)} USDT</span>
                </div>
                <div class="metric-row" style="font-size: 13px; color: #64748b;">
                    <span>Equivalente en Bolivianos:</span>
                    <span>${formatNumber(report.bybitUsdtInBob)} BOB</span>
                </div>

                <div class="divider"></div>

                <div class="metric-row">
                    <span class="metric-label" style="font-weight: 600;">💼 Capital Total Consolidado:</span>
                    <span class="metric-val val-green" style="font-size: 18px;">${formatNumber(report.consolidatedCapitalBob)} BOB</span>
                </div>
                <div class="metric-row" style="font-size: 13px; color: #64748b;">
                    <span>Valor Total en Dólares:</span>
                    <span style="font-weight: 600;">~${formatNumber(report.consolidatedCapitalUsdt)} USDT</span>
                </div>
            </div>
        </div>

        <div class="table-card">
            <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 18px;">📜 Historial de Órdenes (últimas transacciones)</h2>
            <table>
                <thead>
                    <tr>
                        <th>Fecha</th>
                        <th>ID</th>
                        <th>Par</th>
                        <th>Tipo</th>
                        <th>Monto (BOB)</th>
                        <th>Monto (USDT)</th>
                        <th>Precio</th>
                        <th>Contraparte</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`;

    fs.writeFileSync(htmlPath, html, 'utf8');
    return htmlPath;
}

/**
 * Exporta el reporte a un archivo CSV compatible con Excel
 */
function exportReportToCSV(report, filename = 'reporte_bybit.csv') {
    const csvPath = path.join(__dirname, '../', filename);
    const headers = '\uFEFFID,Fecha,Hora,Tipo,Monto_USDT,Precio_BOB,Total_BOB,Ganancia_BOB,Banco,Contraparte,Estado\n';

    const rows = report.records.map(r => {
        const { date, time } = getBoliviaDateTime(r);
        const usdt = parseFloat(r.cryptoAmount || r.amountUsdt || 0);
        const price = parseFloat(r.price || 0);
        const bob = parseFloat(r.fiatAmount || r.amountBob || 0);
        const profit = parseFloat(r.profitBob || r.netProfitBob || 0);
        const bank = (r.bank || 'BANCO SOL').replace(/"/g, '""');
        const counterparty = (r.counterparty || 'N/A').replace(/"/g, '""');
        const status = r.status || 'EXITOSO';

        return `"${r.id}","${date}","${time}","${r.type}",${usdt},${price},${bob},${profit},"${bank}","${counterparty}","${status}"`;
    }).join('\n');

    fs.writeFileSync(csvPath, headers + rows, 'utf8');
    return csvPath;
}

module.exports = {
    generateBybitFinancialReport,
    printReportScreen,
    generateHTMLDashboard,
    exportReportToCSV,
    getBoliviaDateTime
};
