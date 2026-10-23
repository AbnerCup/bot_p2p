/**
 * Módulo de Verificación Estricta de Titularidad
 * Asegura que el dinero solo se transfiera si el titular del banco/QR
 * coincide con el comerciante verificado en Bybit P2P (Evita estafas de triangulación / pagos a terceros).
 */

function cleanName(name) {
    if (!name) return '';
    return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Elimina tildes
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, '') // Elimina caracteres especiales
        .trim()
        .replace(/\s+/g, ' '); // Elimina espacios dobles
}

function verifyHolderName(bybitName, bankName) {
    const cleanBybit = cleanName(bybitName);
    const cleanBank = cleanName(bankName);

    if (!cleanBybit || !cleanBank) {
        return {
            isValid: false,
            reason: 'Nombre de Bybit o del banco vacío.'
        };
    }

    // Coincidencia exacta
    if (cleanBybit === cleanBank) {
        return { isValid: true, reason: 'Coincidencia exacta.' };
    }

    const wordsBybit = cleanBybit.split(' ').filter(w => w.length > 1);
    const wordsBank = cleanBank.split(' ').filter(w => w.length > 1);

    // Contar cuántas palabras coinciden
    let matchingWords = 0;
    wordsBybit.forEach(w => {
        if (wordsBank.includes(w)) {
            matchingWords++;
        }
    });

    // Se requiere que al menos el 70% de las palabras principales o al menos 2 palabras clave coincidan (Nombre + Apellido)
    const minMatchesNeeded = Math.min(2, Math.max(1, wordsBybit.length));

    if (matchingWords >= minMatchesNeeded) {
        return {
            isValid: true,
            reason: `Coincidencia parcial válida (${matchingWords}/${wordsBybit.length} palabras clave coinciden).`
        };
    }

    return {
        isValid: false,
        reason: `¡ALERTA DE SEGURIDAD! El titular del banco (${cleanBank}) no coincide suficientemente con el registrado en Bybit (${cleanBybit}).`
    };
}

module.exports = {
    cleanName,
    verifyHolderName
};
