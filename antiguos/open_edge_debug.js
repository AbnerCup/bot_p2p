/**
 * Script para abrir tu Microsoft Edge Principal con Puerto 9222 Habilitado
 * Permite que el bot se conecte directamente a tu ventana de Edge donde YA estás logueado.
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');

console.log('=============================================================');
console.log(' 🌐 CONECTANDO A TU MICROSOFT EDGE PRINCIPAL (PUERTO 9222)');
console.log('=============================================================');
console.log('Se reiniciará Microsoft Edge para habilitar el puerto de automatización.');
console.log('Tu sesión activa de Binance y tus credenciales se abrirán intactas.');
console.log('El bot P2P se conectará directamente a tu navegador.');
console.log('=============================================================\n');

// Cerrar instancias previas para que Edge acepte la bandera --remote-debugging-port
try {
    execSync('taskkill /F /IM msedge.exe /T', { stdio: 'ignore' });
} catch (e) {}

const p1 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const p2 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const exePath = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : 'msedge');

const command = `"${exePath}" --remote-debugging-port=9222 "https://www.binance.com/es/my/wallet/account/funding"`;

exec(command, (err) => {
    if (err) {
        console.error('❌ Error al iniciar Microsoft Edge:', err.message);
    } else {
        console.log('✅ Microsoft Edge iniciado con tu perfil principal en puerto 9222.');
        console.log('El bot usará tu ventana de Edge abierta sin pedir inicios de sesión.');
    }
});
