/**
 * Módulo Decodificador de Códigos QR (Simple QR Bolivia - EMVCo / JSON)
 * Lee una imagen de QR (PNG/JPG), la decodifica y extrae los datos clave para transferencias directas.
 */

const jimpModule = require('jimp');
const Jimp = jimpModule.Jimp || jimpModule;
const jsQR = require('jsqr');

/**
 * Parser TLV (Tag-Length-Value) con tolerancia a variantes
 */
function parseEMVCoTLV(qrText) {
    const tags = {};
    let index = 0;

    while (index < qrText.length - 4) {
        const tag = qrText.substring(index, index + 2);
        const lengthStr = qrText.substring(index + 2, index + 4);
        const length = parseInt(lengthStr, 10);

        if (isNaN(length) || length < 0 || index + 4 + length > qrText.length) {
            break;
        }

        const value = qrText.substring(index + 4, index + 4 + length);
        tags[tag] = value;
        index += 4 + length;
    }

    return tags;
}

/**
 * Parsea la cadena interna del QR boliviano
 */
function parseQRPayload(qrText) {
    if (!qrText) return null;

    // Case 1: JSON Directo
    if (qrText.trim().startsWith('{') && qrText.trim().endsWith('}')) {
        try {
            const data = JSON.parse(qrText);
            return {
                accountNumber: String(data.account || data.cuenta || data.nroCuenta || ''),
                bankName: data.bank || data.banco || 'BANCO DESTINO',
                holderName: data.name || data.titular || data.nombre || '',
                amountBob: parseFloat(data.amount || data.monto || 0),
                raw: qrText
            };
        } catch (e) {}
    }

    let holderName = '';
    let accountNumber = '';
    let amountBob = 0;
    let bankName = 'SIMPLE QR BOLIVIA';

    // Intento 1: Parser TLV
    const tlv = parseEMVCoTLV(qrText);

    if (tlv['59']) holderName = tlv['59'].trim();
    if (tlv['54']) amountBob = parseFloat(tlv['54']);

    for (let tagNum = 26; tagNum <= 51; tagNum++) {
        const tagStr = String(tagNum);
        if (tlv[tagStr]) {
            const subTlv = parseEMVCoTLV(tlv[tagStr]);
            if (subTlv['01']) accountNumber = subTlv['01'];
            else if (subTlv['02']) accountNumber = subTlv['02'];
        }
    }

    // Intento 2: Fallback Regex de alto rendimiento si falló el TLV estricto
    if (!holderName) {
        const nameMatch = qrText.match(/(?:59\d{2}|TITULAR:|NOMBRE:)([A-Z\s]{3,35})/i);
        if (nameMatch) {
            // Limpiar texto de tags subsiguientes si las hay
            holderName = nameMatch[1].replace(/60\d{2}.*$/, '').trim();
        }
    }

    if (!accountNumber) {
        const accountMatch = qrText.match(/(?:0116|0114|0216|0214|CUENTA:?)\s*(\d{8,16})/i) || qrText.match(/\b\d{8,16}\b/);
        if (accountMatch) {
            accountNumber = accountMatch[1] || accountMatch[0];
        }
    }

    if (!amountBob || isNaN(amountBob)) {
        const amountMatch = qrText.match(/(?:54\d{2}|MONTO:?\s*)(\d+(?:\.\d{1,2})?)/i);
        if (amountMatch) {
            amountBob = parseFloat(amountMatch[1]);
        }
    }

    return {
        accountNumber,
        bankName,
        holderName,
        amountBob,
        raw: qrText
    };
}

const Tesseract = require('tesseract.js');

/**
 * Parsea el texto visible reconocido por OCR en la tarjeta QR
 */
function parseCardText(ocrText) {
    if (!ocrText) return {};

    const clean = ocrText.replace(/\r/g, '\n');
    let holderName = '';
    let accountNumber = '';
    let bankName = '';

    // 1. Detectar Banco
    const lower = clean.toLowerCase();
    if (lower.includes('económico') || lower.includes('economico')) bankName = 'Banco Económico S.A.';
    else if (lower.includes('solidario') || lower.includes('bancosol') || lower.includes('sol')) bankName = 'Banco Solidario S.A.';
    else if (lower.includes('crédito') || lower.includes('credito') || lower.includes('bcp')) bankName = 'Banco de Crédito de Bolivia S.A.';
    else if (lower.includes('unión') || lower.includes('union')) bankName = 'Banco Unión S.A.';
    else if (lower.includes('mercantil') || lower.includes('bmsc')) bankName = 'Banco Mercantil Santa Cruz S.A.';
    else if (lower.includes('nacional') || lower.includes('bnb')) bankName = 'Banco Nacional de Bolivia S.A.';
    else if (lower.includes('ganadero')) bankName = 'Banco Ganadero S.A.';
    else if (lower.includes('fie')) bankName = 'Banco FIE S.A.';

    // 2. Detectar Titular ("Pagar a: ...", "Titular: ...", "Nombre: ...")
    const nameMatch = clean.match(/(?:pagar a:?|titular:?|nombre:?|beneficiario:?)\s*([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{4,40})/i);
    if (nameMatch) {
        holderName = nameMatch[1].split('\n')[0].trim();
    }

    // 3. Detectar Cuenta ("A la cuenta: ...", "Cuenta: ...")
    const accMatch = clean.match(/(?:a la cuenta:?|cuenta:?|nro\.?\s*cuenta:?)\s*([0-9]{7,18})/i) || clean.match(/\b([1-4][0-9]{7,15})\b/);
    if (accMatch) {
        accountNumber = accMatch[1];
    }

    return {
        holderName,
        accountNumber,
        bankName,
        ocrText
    };
}

/**
 * Lee una imagen desde un path local y combina jsQR con OCR
 */
async function decodeQRImage(imagePath) {
    let result = {
        accountNumber: '',
        bankName: 'SIMPLE QR BOLIVIA',
        holderName: '',
        amountBob: 0,
        raw: ''
    };

    try {
        const image = await Jimp.read(imagePath);
        const imageData = {
            data: new Uint8ClampedArray(image.bitmap.data),
            width: image.bitmap.width,
            height: image.bitmap.height
        };

        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
            const parsed = parseQRPayload(code.data);
            if (parsed) result = { ...result, ...parsed };
        }
    } catch (e) {}

    // Si falta titular o número de cuenta, aplicar OCR a la tarjeta gráfica
    if (!result.holderName || !result.accountNumber) {
        try {
            const { data: { text } } = await Tesseract.recognize(imagePath, 'spa+eng');
            const cardData = parseCardText(text);

            if (cardData.holderName && !result.holderName) result.holderName = cardData.holderName;
            if (cardData.accountNumber && !result.accountNumber) result.accountNumber = cardData.accountNumber;
            if (cardData.bankName && (result.bankName === 'SIMPLE QR BOLIVIA' || !result.bankName)) result.bankName = cardData.bankName;
        } catch (ocrErr) {}
    }

    return result;
}

module.exports = {
    decodeQRImage,
    parseQRPayload,
    parseCardText
};
