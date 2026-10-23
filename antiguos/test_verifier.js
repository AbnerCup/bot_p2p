const { verifyHolderName } = require('./security/verifier');

console.log('--- Probando Módulo de Verificación de Nombres ---');

const testCases = [
    { bybit: 'Juan Carlos Pérez Gómez', bank: 'JUAN CARLOS PEREZ GOMEZ', expected: true },
    { bybit: 'Juan Pérez', bank: 'PÉREZ GÓMEZ JUAN CARLOS', expected: true },
    { bybit: 'Carlos Mamani', bank: 'RODRIGO FLORES ZURITA', expected: false },
    { bybit: 'Maria Lopez', bank: 'MARIA LOPEZ', expected: true }
];

testCases.forEach((tc, idx) => {
    const res = verifyHolderName(tc.bybit, tc.bank);
    const passed = res.isValid === tc.expected;
    console.log(`[Test #${idx + 1}] ${passed ? '✅ PASÓ' : '❌ FALLÓ'}`);
    console.log(`  Bybit: "${tc.bybit}" vs Banco: "${tc.bank}"`);
    console.log(`  Resultado: ${res.isValid} (${res.reason})\n`);
});
