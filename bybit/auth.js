/**
 * Script Dedicado de Autenticación de Bybit P2P
 * Mantiene la ventana abierta y espera de forma activa HASTA que completes el inicio de sesión
 * y estés autenticado en Bybit.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config');

const SESSION_FILE = path.join(__dirname, '../session_bybit.json');

async function initSession() {
    console.log('=============================================================');
    console.log('   🔑 INICIADOR DEDICADO DE SESIÓN DE BYBIT P2P               ');
    console.log('=============================================================\n');

    let storageState = undefined;
    if (fs.existsSync(SESSION_FILE)) {
        console.log('Cargando sesión previa existente...');
        storageState = SESSION_FILE;
    }

    const browser = await chromium.launch({
        headless: false, // Visible para inicio de sesión o interacción
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        storageState: storageState,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    console.log('Navegando a la página de login / OTC de Bybit...');
    await page.goto('https://www.bybit.com/user/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    console.log('\n=============================================================');
    console.log('📌 INSTRUCCIONES EN PANTALLA:');
    console.log('Por favor completa el inicio de sesión o verificación de seguridad en la ventana del navegador.');
    console.log('El script detectará automáticamente en cuanto entres a tu cuenta.');
    console.log('=============================================================\n');

    // Esperar de forma activa hasta que el usuario se encuentre dentro de la zona autenticada
    let isAuthenticated = false;
    for (let i = 0; i < 150; i++) { // Espera de hasta 5 minutos
        await page.waitForTimeout(2000);
        const url = page.url();
        if (!url.includes('/login') && !url.includes('/register') && !url.includes('/security')) {
            console.log(`🎉 ¡Login autenticado detectado en: ${url}!`);
            isAuthenticated = true;
            break;
        }
    }

    if (isAuthenticated) {
        console.log('Navegando a Bybit OTC P2P para sincronizar cookies de sesión...');
        await page.goto('https://www.bybit.com/fiat/trade/otc/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForTimeout(4000);
    }

    await context.storageState({ path: SESSION_FILE });
    console.log(`\n✅ ¡Sesión AUTENTICADA guardada con éxito en: ${SESSION_FILE}!`);

    await browser.close();
    console.log('Iniciador de sesión finalizado.');
}

if (require.main === module) {
    initSession().catch(err => console.error('Error al iniciar sesión:', err));
}

module.exports = { initSession, SESSION_FILE };
