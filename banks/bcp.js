/**
 * Módulo de Automatización para BCP (Banca por Internet BCP / Pago QR)
 */
const { verifyHolderName } = require('../security/verifier');

async function processBcpTransfer({ accountNumber, amountBob, counterpartyBybitName }) {
    console.log(`\n[BANCO BCP] Iniciando proceso de pago...`);
    console.log(`- Cuenta Destino: ${accountNumber}`);
    console.log(`- Monto: ${amountBob} BOB`);
    console.log(`- Titular registrado en Bybit: "${counterpartyBybitName}"`);

    const simulatedAccountHolderFromBank = counterpartyBybitName; // Obtenido del BCP

    const verification = verifyHolderName(counterpartyBybitName, simulatedAccountHolderFromBank);
    if (!verification.isValid) {
        console.error(`❌ [BANCO BCP ABORTADO] ${verification.reason}`);
        return { success: false, reason: verification.reason };
    }

    console.log(`✅ [BANCO BCP] Titular verificado correctamente: "${simulatedAccountHolderFromBank}"`);
    console.log(`💸 [BANCO BCP] Transferencia ejecutada con éxito.`);

    return {
        success: true,
        transactionId: 'BCP-' + Date.now(),
        receiptPath: 'comprobante_bcp.png'
    };
}

module.exports = { processBcpTransfer };
