const { recordMovement, generateReport, exportToCSV } = require('./utils/ledger');

console.log('--- GENERANDO MOVIMIENTOS DE PRUEBA EN EL HISTORIAL ---');

recordMovement({
    orderId: 'ORD-1001',
    type: 'COMPRA',
    cryptoAmount: 100.00,
    fiatAmount: 1165.00,
    price: 11.65,
    profitBob: 5.00,
    bank: 'BANCO SOL',
    counterparty: 'Juan Pérez'
});

recordMovement({
    orderId: 'ORD-1002',
    type: 'VENTA',
    cryptoAmount: 50.00,
    fiatAmount: 585.00,
    price: 11.70,
    profitBob: 2.50,
    bank: 'BANCO SOL',
    counterparty: 'Carlos Mamani'
});

recordMovement({
    orderId: 'ORD-1003',
    type: 'COMPRA',
    cryptoAmount: 200.00,
    fiatAmount: 2330.00,
    price: 11.65,
    profitBob: 10.00,
    bank: 'BANCO SOL',
    counterparty: 'Maria Lopez'
});

console.log('\n--- MOSTRANDO REPORTE FINANCIERO ---');
generateReport('2026-09-01', '2026-09-12');

console.log('\n--- EXPORTANDO A EXCEL/CSV ---');
exportToCSV('2026-09-01', '2026-09-12');
