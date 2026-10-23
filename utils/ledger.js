/**
 * Módulo de Registro Histórico y Reportes P2P
 * Registra todas las compras, ventas y ganancias en history.json
 * Genera reportes financieros filtrados por rango de fechas y exporta a CSV.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../history.json');

/**
 * Carga el historial existente
 */
function loadHistory() {
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
 * Obtiene la fecha (YYYY-MM-DD) y hora (HH:mm:ss) en la zona horaria local de Bolivia (America/La_Paz)
 */
function getLocalItemDateTime(item) {
    if (item.timestamp) {
        const dateObj = new Date(item.timestamp);
        if (!isNaN(dateObj.getTime())) {
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
            return {
                date: dateFormatter.format(dateObj),
                time: timeFormatter.format(dateObj)
            };
        }
    }
    return {
        date: item.date || '',
        time: '--:--:--'
    };
}

/**
 * Registra un nuevo movimiento en el historial
 */
function recordMovement({
    orderId,
    type, // 'COMPRA' o 'VENTA'
    cryptoAmount, // USDT
    fiatAmount, // BOB
    price, // BOB/USDT
    profitBob = 0, // Ganancia estimada en BOB
    bank = 'BANCO SOL',
    counterparty = 'Desconocido',
    status = 'EXITOSO',
    reason = ''
}) {
    const history = loadHistory();
    const now = new Date();

    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/La_Paz',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const localDateStr = dateFormatter.format(now);

    const record = {
        id: orderId || 'ORD-' + Date.now(),
        date: localDateStr, // YYYY-MM-DD en hora local de Bolivia
        timestamp: now.toISOString(),
        type,
        cryptoAmount: parseFloat(cryptoAmount || 0),
        fiatAmount: parseFloat(fiatAmount || 0),
        price: parseFloat(price || 0),
        profitBob: parseFloat(profitBob || 0),
        bank,
        counterparty,
        status,
        reason
    };

    record.cryptoAmount = parseFloat(cryptoAmount || record.amountUsdt || 0);
    record.fiatAmount = parseFloat(fiatAmount || record.amountBob || 0);
    record.profitBob = parseFloat(profitBob || record.netProfitBob || 0);

    history.push(record);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

    console.log(`📝 [HISTORIAL]: Movimiento #${record.id} registrado (${record.type} ${record.cryptoAmount} USDT por ${record.fiatAmount} BOB).`);
    return record;
}

function recordTransaction(params) {
    return recordMovement({
        orderId: params.orderId,
        type: params.type,
        cryptoAmount: params.cryptoAmount || params.amountUsdt,
        fiatAmount: params.fiatAmount || params.amountBob,
        price: params.price,
        profitBob: params.profitBob || params.netProfitBob,
        bank: params.bank,
        counterparty: params.counterparty,
        status: params.status || 'EXITOSO',
        reason: params.reason || ''
    });
}

/**
 * Genera un reporte filtrado por rango de fechas (YYYY-MM-DD)
 */
function generateReport(startDate = null, endDate = null) {
    const history = loadHistory();

    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate + 'T23:59:59') : new Date();

    const filtered = history.filter(item => {
        const { date } = getLocalItemDateTime(item);
        const itemDate = new Date(date + 'T12:00:00');
        return itemDate >= start && itemDate <= end;
    });

    let totalUsdtBought = 0;
    let totalUsdtSold = 0;
    let totalBobSpent = 0;
    let totalBobEarned = 0;
    let totalProfitBob = 0;
    let successfulCount = 0;
    let abortedCount = 0;

    filtered.forEach(item => {
        if (item.status === 'EXITOSO') {
            successfulCount++;
            if (item.type === 'COMPRA') {
                totalUsdtBought += item.cryptoAmount;
                totalBobSpent += item.fiatAmount;
            } else if (item.type === 'VENTA') {
                totalUsdtSold += item.cryptoAmount;
                totalBobEarned += item.fiatAmount;
            }
            totalProfitBob += item.profitBob;
        } else {
            abortedCount++;
        }
    });

    const reportRangeText = (startDate || endDate) 
        ? `Del ${startDate || 'Inicio'} al ${endDate || 'Hoy'}`
        : 'Histórico Completo';

    console.log('\n=============================================================');
    console.log(` 📊 REPORTE FINANCIERO P2P (${reportRangeText})`);
    console.log('=============================================================');
    console.log(`🔹 Órdenes Exitosas: ${successfulCount} | Alertas / Abortadas: ${abortedCount}`);
    console.log(`🔹 Total USDT Comprado: ${totalUsdtBought.toFixed(2)} USDT (Gasto: ${totalBobSpent.toFixed(2)} BOB)`);
    console.log(`🔹 Total USDT Vendido:  ${totalUsdtSold.toFixed(2)} USDT (Ingreso: ${totalBobEarned.toFixed(2)} BOB)`);
    console.log(`-------------------------------------------------------------`);
    console.log(`💵 GANANCIA NETA TOTAL: +${totalProfitBob.toFixed(2)} BOB`);
    console.log('=============================================================\n');

    return {
        filteredRecords: filtered,
        totalUsdtBought,
        totalUsdtSold,
        totalBobSpent,
        totalBobEarned,
        totalProfitBob,
        successfulCount,
        abortedCount
    };
}

/**
 * Exporta el reporte a un archivo CSV para abrir en Excel
 */
function exportToCSV(startDate = null, endDate = null, filename = 'reporte_p2p.csv') {
    const { filteredRecords } = generateReport(startDate, endDate);

    const headers = 'ID,Fecha,Hora,Tipo,USDT,BOB,Precio,Ganancia_BOB,Banco,Contraparte,Estado\n';
    const rows = filteredRecords.map(r => {
        const { date, time } = getLocalItemDateTime(r);
        return `"${r.id}","${date}","${time}","${r.type}",${r.cryptoAmount},${r.fiatAmount},${r.price},${r.profitBob},"${r.bank}","${r.counterparty}","${r.status}"`;
    }).join('\n');

    const csvPath = path.join(__dirname, '../', filename);
    fs.writeFileSync(csvPath, headers + rows, 'utf8');
    console.log(`📁 Reporte exportado a Excel/CSV en: ${csvPath}`);
    return csvPath;
}

module.exports = {
    loadHistory,
    recordMovement,
    recordTransaction,
    generateReport,
    exportToCSV
};
