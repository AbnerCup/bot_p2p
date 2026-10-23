/**
 * Servidor Web Móvil en Tiempo Real para Autorización de Transferencias
 * Se conecta con tu smartphone dentro de la red Wi-Fi y canaliza el Token Móvil.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tokenBridge = require('./token_bridge');
const { getDailyReport } = require('../utils/ledger');

const PORT = process.env.WEB_PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Clientes SSE conectados en el teléfono
const sseClients = new Set();

/**
 * Encuentra la dirección IP local de la computadora en la red Wi-Fi
 */
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * Notifica a todos los teléfonos móviles conectados vía SSE
 */
function broadcastSSE(type, data) {
    const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

// Suscripción a eventos del TokenBridge
tokenBridge.on('token_requested', (transfer) => {
    broadcastSSE('TOKEN_REQUESTED', transfer);
});

tokenBridge.on('transfer_completed', (result) => {
    broadcastSSE('TRANSFER_COMPLETED', result);
});

tokenBridge.on('transfer_cancelled', (info) => {
    broadcastSSE('TRANSFER_CANCELLED', info);
});

/**
 * Crea y arranca el servidor HTTP
 */
function startWebServer(port = PORT) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // CORS headers para desarrollo flexible
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        // 1. Canal de Eventos en Tiempo Real (SSE)
        if (url.pathname === '/api/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.write('\n');

            sseClients.add(res);

            // Enviar estado actual si hay una transferencia esperando
            const pending = tokenBridge.getPendingTransfer();
            res.write(`data: ${JSON.stringify({ type: 'STATUS_UPDATE', data: { pendingTransfer: pending } })}\n\n`);

            req.on('close', () => {
                sseClients.delete(res);
            });
            return;
        }

        // 2. Endpoint para Enviar Token desde el Celular
        if (url.pathname === '/api/authorize' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const result = tokenBridge.submitToken(parsed.token);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, reason: 'Formato inválido' }));
                }
            });
            return;
        }

        // 3. Endpoint de Estado y Estadísticas
        if (url.pathname === '/api/stats') {
            let profit = 0;
            try {
                const report = getDailyReport();
                profit = report.summary ? report.summary.totalProfitBob : 0;
            } catch (e) {}

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ONLINE',
                pendingTransfer: tokenBridge.getPendingTransfer(),
                dailyProfitBob: profit,
                balanceUsdt: 355.22 // Balance referencial actualizado
            }));
            return;
        }

        // 4. Endpoint para Ver Comprobante
        if (url.pathname === '/api/receipt') {
            const receiptSuccess = path.join(__dirname, '../comprobante_bancosol_exito.png');
            const receiptStep = path.join(__dirname, '../comprobante_bancosol.png');
            const filePath = fs.existsSync(receiptSuccess) ? receiptSuccess : (fs.existsSync(receiptStep) ? receiptStep : null);

            if (filePath && fs.existsSync(filePath)) {
                res.writeHead(200, { 'Content-Type': 'image/png' });
                return fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Comprobante no disponible aún');
            }
        }

        // 5. Endpoint de prueba para disparar alerta en el celular
        if (url.pathname === '/api/test_alert' && req.method === 'POST') {
            tokenBridge.requestToken({
                orderId: 'TEST-' + Math.floor(Math.random() * 9000 + 1000),
                beneficiaryName: 'ROJAS AGUILAR CRISTIAN GONZALO',
                destinationBank: 'Banco de Crédito de Bolivia',
                accountNumber: '1091873472',
                amountBob: 50.00,
                glosa: 'Prueba Alerta Móvil P2P'
            }).catch(() => {});

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'Alerta de prueba disparada' }));
        }

        // 6. Archivos Estáticos (Frontend Móvil)
        let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            const contentType = ext === '.html' ? 'text/html' : (ext === '.css' ? 'text/css' : 'application/javascript');
            res.writeHead(200, { 'Content-Type': contentType });
            return fs.createReadStream(filePath).pipe(res);
        }

        // Fallback al index.html
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return fs.createReadStream(indexPath).pipe(res);
        }

        res.writeHead(404);
        res.end('Página no encontrada');
    });

    server.listen(port, '0.0.0.0', () => {
        const localIp = getLocalIpAddress();
        console.log('\n=============================================================');
        console.log(' 📱 MINI WEB APP MÓVIL INICIADA PARA CONTROL DE TOKEN');
        console.log('=============================================================');
        console.log(`🌐 Acceso local en la PC:  http://localhost:${port}`);
        console.log(`📲 Acceso desde tu Celular: http://${localIp}:${port}`);
        console.log('-------------------------------------------------------------');
        console.log(`👉 Abre la dirección de tu Celular en Chrome/Safari conectado`);
        console.log(`   a la misma red Wi-Fi para autorizar transferencias.`);
        console.log('=============================================================\n');
    });

    return server;
}

if (require.main === module) {
    startWebServer(PORT);
}

module.exports = {
    startWebServer,
    getLocalIpAddress,
    PORT
};
