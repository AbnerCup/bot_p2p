/**
 * CLI de Reportes Financieros y Ganancias Bybit P2P
 * 
 * Uso:
 * 1. Ver todo el histórico de movimientos, compras, ventas y ganancias:
 *    node bybit_report.js
 * 
 * 2. Ver únicamente los movimientos del día de hoy:
 *    node bybit_report.js --today
 * 
 * 3. Ver una fecha específica (YYYY-MM-DD):
 *    node bybit_report.js 2026-09-18
 * 
 * 4. Filtrar solo movimientos de Bybit:
 *    node bybit_report.js --bybit
 * 
 * 5. Exportar a Excel (CSV):
 *    node bybit_report.js --export
 */

const { generateBybitFinancialReport, printReportScreen, generateHTMLDashboard, exportReportToCSV, getBoliviaDateTime } = require('./bybit/report');

async function main() {
    const args = process.argv.slice(2);

    let targetDate = null;
    let bybitOnly = args.includes('--bybit');
    const shouldExport = args.includes('--export') || args.includes('--csv');
    const shouldHtml = args.includes('--html');

    if (args.includes('--today') || args.includes('-t')) {
        const { date } = getBoliviaDateTime(new Date());
        targetDate = date;
    } else {
        const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
        if (dateArg) {
            targetDate = dateArg;
        }
    }

    console.clear();
    console.log('⏳ Recopilando datos de mercado, saldos en Bybit, Banco Sol e historial...');

    const report = await generateBybitFinancialReport({
        targetDate,
        bybitOnly,
        liveSaldos: true
    });

    console.clear();
    printReportScreen(report);

    // Siempre generar el HTML para que el usuario pueda abrirlo en el navegador con un click
    const htmlPath = generateHTMLDashboard(report, 'reporte_bybit.html');
    console.log(`🌐 Vista visual HTML generada en: ${htmlPath}`);

    if (shouldExport) {
        const filename = targetDate ? `reporte_bybit_${targetDate}.csv` : 'reporte_bybit.csv';
        const exportedPath = exportReportToCSV(report, filename);
        console.log(`📁 ¡Reporte exportado exitosamente a Excel en: ${exportedPath}\n`);
    } else {
        console.log('💡 Tip: Agrega --export para generar un archivo CSV para Excel (ej: node bybit_report.js --export)\n');
    }
}

if (require.main === module) {
    main().catch(err => console.error('Error al generar reporte:', err));
}

module.exports = { main };
