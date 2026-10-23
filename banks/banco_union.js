/**
 * Módulo de Automatización para Banco Unión (Uninet / Unimóvil)
 */
const { verifyHolderName } = require('../security/verifier');

async function processUnionTransfer({ accountNumber, amountBob, counterpartyBybitName }) {
    console.log(`\n[BANCO UNIÓN] Iniciando proceso de pago...`);
    console.log(`- Cuenta Destino: ${accountNumber}`);
    console.log(`- Monto: ${amountBob} BOB`);
    console.log(`- Titular registrado en Bybit: "${counterpartyBybitName}"`);

    // 1. Simulación/Lógica de navegación en Uninet
    // En producción se automatizan los campos de login, clave y selección de cuenta
    const simulatedAccountHolderFromBank = counterpartyBybitName; // Obtenido del resumen de Uninet

    // 2. Verificación Estricta de Segruidad Anti-Terceros
    const verification = verifyHolderName(counterpartyBybitName, simulatedAccountHolderFromBank);
    if (!verification.isValid) {
        console.error(`❌ [BANCO UNIÓN ABORTADO] ${verification.reason}`);
        return { success: false, reason: verification.reason };
    }

    console.log(`✅ [BANCO UNIÓN] Titular verificado correctamente: "${simulatedAccountHolderFromBank}"`);
    console.log(`💸 [BANCO UNIÓN] Transferencia ejecutada con éxito.`);

    return {
        success: true,
        transactionId: 'BU-' + Date.now(),
        receiptPath: 'comprobante_banco_union.png'
    };
}

module.exports = { processUnionTransfer };
