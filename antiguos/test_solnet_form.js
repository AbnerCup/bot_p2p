/**
 * Script de prueba de llenado automático del formulario en SolNet Digital
 */
const { executeSolNetFormTransfer } = require('./banks/bancosol');

(async () => {
    console.log('--- PROBANDO AUTOMATIZACIÓN DE FORMULARIO DE BANCO SOL ---');

    await executeSolNetFormTransfer({
        destinationBank: 'Banco Mercantil Santa Cruz S.A.',
        beneficiaryName: 'ABNER COPA',
        accountNumber: '100000012345',
        amountBob: 10.00
    });
})();

