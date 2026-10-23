/**
 * Analizador Ejecutivo de Movimientos y Ganancias Diarias P2P
 * 
 * Uso:
 * 1. Analizar el día de hoy:
 *    node analyze_daily_profit.js
 * 
 * 2. Analizar un día específico (YYYY-MM-DD):
 *    node analyze_daily_profit.js 2026-09-17
 * 
 * 3. Exportar el día a Excel:
 *    node analyze_daily_profit.js --export
 */

const fs = require('fs');
const path = require('path');
const { getLiveBinanceBalancesFromApi, getConsolidatedBalances } = require('./binance/balances');

const HISTORY_FILE = path.join(__dirname, 'history.json');
const EXPORT_CSV = path.join(__dirname, 'ganancias_del_dia.csv');

// Obtener fecha objetivo (por defecto hoy en hora de Bolivia)
function getTargetDate() {
    const argDate = process.argv.find(a => a.match(/^\d{4}-\d{2}-\d{2}$/));
    if (argDate) return argDate;

    // Fecha local de Bolivia
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/La_Paz',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    return formatter.format(now);
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

async function analyzeDailyProfits() {
    const targetDate = getTargetDate();
    const shouldExport = process.argv.includes('--export') || process.argv.includes('--csv');

    console.clear();
    console.log('================================================================================');
    console.log(` 💼 BALANCE Y AUDITORÍA FINANCIERA DIARIA P2P [${targetDate}]`);
    console.log('================================================================================\n');

    // 1. Cargar historial
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {
            history = [];
        }
    }

    // Filtrar movimientos del día objetivo en hora local de Bolivia
    const dayRecords = history.filter(item => {
        if (!item.timestamp && !item.date) return false;
        const { date } = getLocalItemDateTime(item);
        return date === targetDate;
    });

    // 2. Consultar saldos reales en vivo de Binance
    console.log('⏳ Sincronizando con Binance API en tiempo real...');
    let liveBalances = null;
    try {
        liveBalances = await getLiveBinanceBalancesFromApi();
    } catch (e) {}

    console.clear();
    console.log('================================================================================');
    console.log(` 💼 BALANCE Y AUDITORÍA FINANCIERA DIARIA P2P [${targetDate}]`);
    console.log('================================================================================');

    if (dayRecords.length === 0) {
        console.log(`\nℹ️ No se registraron movimientos en la fecha: ${targetDate}`);
        console.log('Todas las transacciones que realices hoy se listarán aquí automáticamente.\n');
    } else {
        let totalBoughtUsdt = 0;
        let totalSoldUsdt = 0;
        let totalSpentBob = 0;
        let totalReceivedBob = 0;
        let totalProfitBob = 0;
        let buyCount = 0;
        let sellCount = 0;

        console.log('\n📋 DESGLOSE DE MOVIMIENTOS DEL DÍA:');
        console.log('--------------------------------------------------------------------------------');
        console.log(' HORA     | TIPO   | MONTO USDT | PRECIO BOB | TOTAL BOB   | GANANCIA BOB | CONTRAPARTE');
        console.log('--------------------------------------------------------------------------------');

        dayRecords.forEach(r => {
            const { time } = getLocalItemDateTime(r);
            const typeFormatted = r.type === 'COMPRA' ? '\x1b[32mCOMPRA\x1b[0m ' : '\x1b[31mVENTA \x1b[0m ';
            const usdt = (r.cryptoAmount || 0).toFixed(2).padStart(8, ' ');
            const price = (r.price || 0).toFixed(2).padStart(8, ' ');
            const bob = (r.fiatAmount || 0).toFixed(2).padStart(9, ' ');
            const profit = (r.profitBob || 0).toFixed(2).padStart(10, ' ');
            const counterparty = (r.counterparty || 'N/A').substring(0, 15);

            if (r.type === 'COMPRA') {
                buyCount++;
                totalBoughtUsdt += r.cryptoAmount || 0;
                totalSpentBob += r.fiatAmount || 0;
            } else if (r.type === 'VENTA') {
                sellCount++;
                totalSoldUsdt += r.cryptoAmount || 0;
                totalReceivedBob += r.fiatAmount || 0;
            }
            totalProfitBob += (r.profitBob || 0);

            console.log(` ${time} | ${typeFormatted} | ${usdt} | ${price} | ${bob} Bs | +${profit} Bs | ${counterparty}`);
        });

        console.log('--------------------------------------------------------------------------------');

        const referenceRate = dayRecords.length > 0 ? (dayRecords[dayRecords.length - 1].price || 11.30) : 11.30;
        const totalProfitUsdt = referenceRate > 0 ? (totalProfitBob / referenceRate) : 0;
        const totalTurnoverBob = totalSpentBob + totalReceivedBob;
        const roiPercent = totalSpentBob > 0 ? ((totalProfitBob / totalSpentBob) * 100).toFixed(2) : '0.00';

        console.log('\n📊 RESUMEN EJECUTIVO DE RENDIMIENTO:');
        console.log('--------------------------------------------------------------------------------');
        console.log(` 📦 Operaciones Totales:    ${dayRecords.length} (${buyCount} Compras / ${sellCount} Ventas)`);
        console.log(` 🟢 Volumen Comprado:       ${totalBoughtUsdt.toFixed(2)} USDT (${totalSpentBob.toFixed(2)} BOB pagados)`);
        console.log(` 🔴 Volumen Vendido:        ${totalSoldUsdt.toFixed(2)} USDT (${totalReceivedBob.toFixed(2)} BOB cobrados)`);
        console.log(` 🔄 Dinero Total Rotado:    ${totalTurnoverBob.toFixed(2)} BOB`);
        console.log('--------------------------------------------------------------------------------');
        console.log(` 💰 GANANCIA NETA DEL DÍA:  \x1b[32m\x1b[1m+${totalProfitBob.toFixed(2)} BOB\x1b[0m (\x1b[36m+${totalProfitUsdt.toFixed(2)} USDT\x1b[0m)`);
        console.log(` 📈 Rentabilidad sobre Giro: \x1b[35m\x1b[1m+${roiPercent}%\x1b[0m`);
        console.log('--------------------------------------------------------------------------------');
    }

    // 3. Estado de capital actual
    if (liveBalances) {
        console.log('\n🏦 ESTADO DE TUS BILLETERAS EN VIVO (BINANCE API):');
        console.log('--------------------------------------------------------------------------------');
        console.log(` 🔹 USDT en Fondos (P2P):   ${liveBalances.usdtFunding.toFixed(2)} USDT`);
        console.log(` 🔹 USDT en Spot:           ${liveBalances.usdtSpot.toFixed(2)} USDT`);
        console.log(` 🔹 Total USDT Disponible:  ${liveBalances.totalUsdt.toFixed(2)} USDT`);
        if (liveBalances.btcTotal > 0) {
            console.log(` 🔸 Bitcoin (BTC):          ${liveBalances.btcTotal} BTC`);
        }
        console.log('================================================================================\n');
    }

    // 4. Exportación opcional a CSV
    if (shouldExport && dayRecords.length > 0) {
        const headers = 'ID,Fecha_Hora,Tipo,Monto_USDT,Precio_BOB,Total_BOB,Ganancia_BOB,Banco,Contraparte\n';
        const rows = dayRecords.map(r => {
            const { date, time } = getLocalItemDateTime(r);
            return `"${r.id}","${date} ${time}","${r.type}",${r.cryptoAmount},${r.price},${r.fiatAmount},${r.profitBob},"${r.bank}","${r.counterparty}"`;
        }).join('\n');

        fs.writeFileSync(EXPORT_CSV, headers + rows, 'utf8');
        console.log(`📁 Reporte exportado a Excel en: ${EXPORT_CSV}\n`);
    }
}

if (require.main === module) {
    analyzeDailyProfits().catch(err => console.error('Error al analizar ganancias:', err));
}

module.exports = {
    analyzeDailyProfits,
    getTargetDate
};
