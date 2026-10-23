/**
 * Herramienta de Reportes Financieros P2P
 * 
 * Uso:
 * 1. Ver todo el histórico:
 *    node report.js
 * 
 * 2. Filtrar por rango de fechas (YYYY-MM-DD):
 *    node report.js 2026-09-01 2026-09-12
 * 
 * 3. Exportar a Excel (CSV):
 *    node report.js --csv
 */

const { generateReport, exportToCSV } = require('./utils/ledger');

const args = process.argv.slice(2);

let startDate = null;
let endDate = null;
let exportCsv = false;

args.forEach(arg => {
    if (arg === '--csv') {
        exportCsv = true;
    } else if (arg.match(/^\d{4}-\d{2}-\d{2}$/)) {
        if (!startDate) startDate = arg;
        else if (!endDate) endDate = arg;
    }
});

generateReport(startDate, endDate);

if (exportCsv) {
    exportToCSV(startDate, endDate);
}
