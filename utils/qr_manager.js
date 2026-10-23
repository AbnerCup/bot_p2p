/**
 * Gestor de Códigos QR del Día (Simple Bolivia)
 * Administra, detecta y valida la imagen del Código QR diario para cobros P2P.
 */

const fs = require('fs');
const path = require('path');
const { decodeQRImage } = require('./qr_decoder');

const QR_DIR = path.join(__dirname, '../qr_dia');

/**
 * Busca y retorna la ruta de la imagen QR activa del día
 */
function getTodayQRPath() {
    if (!fs.existsSync(QR_DIR)) {
        fs.mkdirSync(QR_DIR, { recursive: true });
    }

    // 1. Prioridad: qr_actual.png o qr_actual.jpg
    const primaryPng = path.join(QR_DIR, 'qr_actual.png');
    if (fs.existsSync(primaryPng)) return primaryPng;

    const primaryJpg = path.join(QR_DIR, 'qr_actual.jpg');
    if (fs.existsSync(primaryJpg)) return primaryJpg;

    // 2. Prioridad: Formato de fecha de hoy (qr_YYYY-MM-DD.png)
    const todayStr = new Date().toISOString().split('T')[0];
    const datePng = path.join(QR_DIR, `qr_${todayStr}.png`);
    if (fs.existsSync(datePng)) return datePng;

    const dateJpg = path.join(QR_DIR, `qr_${todayStr}.jpg`);
    if (fs.existsSync(dateJpg)) return dateJpg;

    // 3. Fallback: Buscar la imagen más reciente en la carpeta qr_dia
    const files = fs.readdirSync(QR_DIR)
        .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
        .map(f => ({
            name: f,
            path: path.join(QR_DIR, f),
            time: fs.statSync(path.join(QR_DIR, f)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time);

    if (files.length > 0) {
        return files[0].path;
    }

    return null;
}

/**
 * Analiza e inspecciona el QR del día
 */
async function inspectDailyQR() {
    const qrPath = getTodayQRPath();
    if (!qrPath) {
        return {
            exists: false,
            message: 'No se encontró ninguna imagen en la carpeta /qr_dia/. Coloca tu archivo "qr_actual.png".'
        };
    }

    try {
        const decoded = await decodeQRImage(qrPath);
        return {
            exists: true,
            path: qrPath,
            fileName: path.basename(qrPath),
            decoded: decoded
        };
    } catch (e) {
        return {
            exists: true,
            path: qrPath,
            fileName: path.basename(qrPath),
            error: e.message
        };
    }
}

module.exports = {
    QR_DIR,
    getTodayQRPath,
    inspectDailyQR
};
