const { parseQRPayload } = require('./utils/qr_decoder');

console.log('--- PROBANDO DECODIFICADOR DE PAYLOAD DE QR BOLIVIA ---');

// Ejemplo de Payload de QR Simple Bolivia / EMVCo
const sampleQRPayload = '00020101021226460014bo.com.simpleqr011610000001234567895204599953030685406150.505802BO5918JUAN CARLOS PEREZ6008LA PAZ6304ABCD';

const result = parseQRPayload(sampleQRPayload);

console.log('--- DATOS EXTRAÍDOS DEL QR ---');
console.log(`- Titular: ${result.holderName}`);
console.log(`- N° Cuenta: ${result.accountNumber}`);
console.log(`- Monto BOB: ${result.amountBob} Bs`);
console.log(`- Banco: ${result.bankName}`);
