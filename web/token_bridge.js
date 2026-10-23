/**
 * Puente de Comunicación en Tiempo Real para Autorización de Transferencias y Token Móvil
 * Coordina la solicitud entre la automatización de SolNet y la Mini Web App del celular.
 */

const EventEmitter = require('events');

class TokenBridge extends EventEmitter {
    constructor() {
        super();
        this.pendingTransfer = null;
        this.resolvePromise = null;
        this.rejectPromise = null;
        this.lastCompletedTransfer = null;
    }

    /**
     * Llamado por banks/bancosol.js cuando llega al Paso 3 (Confirmación)
     * Retorna una Promesa que se resolverá cuando el usuario ingrese el token desde el celular o consola.
     */
    requestToken(transferDetails) {
        return new Promise((resolve, reject) => {
            this.pendingTransfer = {
                id: transferDetails.orderId || 'ORD-' + Date.now(),
                beneficiaryName: transferDetails.beneficiaryName,
                destinationBank: transferDetails.destinationBank || transferDetails.bank,
                accountNumber: transferDetails.accountNumber,
                amountBob: transferDetails.amountBob,
                glosa: transferDetails.glosa || transferDetails.note || 'Pago P2P Binance',
                receiptPath: transferDetails.receiptPath || null,
                requestedAt: new Date().toISOString(),
                status: 'WAITING_TOKEN'
            };

            this.resolvePromise = resolve;
            this.rejectPromise = reject;

            console.log(`\n📢 [TOKEN BRIDGE] Solicitud de Token emitida para orden ${this.pendingTransfer.id}`);
            this.emit('token_requested', this.pendingTransfer);
        });
    }

    /**
     * Llamado por el servidor web cuando el usuario envía el código desde su celular
     */
    submitToken(token) {
        const cleanToken = String(token).trim();
        if (!this.pendingTransfer || !this.resolvePromise) {
            return { success: false, reason: 'No hay ninguna transferencia pendiente de autorización.' };
        }

        if (cleanToken.length < 4 || cleanToken.length > 8) {
            return { success: false, reason: 'El código de autorización debe contener entre 4 y 8 dígitos.' };
        }

        console.log(`\n🔑 [TOKEN BRIDGE] Token recibido desde la Web Móvil: ${cleanToken}`);
        
        this.pendingTransfer.status = 'AUTHORIZING';
        this.emit('token_submitting', { token: cleanToken, transfer: this.pendingTransfer });

        const resolver = this.resolvePromise;
        this.resolvePromise = null;
        this.rejectPromise = null;

        resolver(cleanToken);
        return { success: true, message: 'Token recibido y aplicado a Banco Sol.' };
    }

    /**
     * Actualiza el estado final tras la ejecución bancaria
     */
    setTransferCompleted(result) {
        if (this.pendingTransfer) {
            this.lastCompletedTransfer = {
                ...this.pendingTransfer,
                ...result,
                completedAt: new Date().toISOString(),
                status: 'COMPLETED'
            };
            this.pendingTransfer = null;
            this.emit('transfer_completed', this.lastCompletedTransfer);
            console.log(`✅ [TOKEN BRIDGE] Transferencia completada y notificada a la Web Móvil.`);
        }
    }

    /**
     * Cancela o aborta la solicitud pendiente (por timeout o error)
     */
    cancelTransfer(reason) {
        if (this.pendingTransfer) {
            console.log(`⚠️ [TOKEN BRIDGE] Transferencia cancelada: ${reason}`);
            this.emit('transfer_cancelled', { reason });
            if (this.rejectPromise) {
                this.rejectPromise(new Error(reason));
            }
            this.pendingTransfer = null;
            this.resolvePromise = null;
            this.rejectPromise = null;
        }
    }

    getPendingTransfer() {
        return this.pendingTransfer;
    }

    getLastCompletedTransfer() {
        return this.lastCompletedTransfer;
    }
}

const tokenBridge = new TokenBridge();
module.exports = tokenBridge;
