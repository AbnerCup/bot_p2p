/**
 * Script Dedicado de Autenticación de Binance P2P
 * Mantiene la ventana abierta y espera de forma activa HASTA que completes el inicio de sesión
 * y estés dentro de la Billetera de Fondos de Binance.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../config');

const BINANCE_SESSION = path.join(__dirname, '../session_binance.json');

async function initBinanceSessionDedicated() {
    console.log('=============================================================');
    console.log('   🔑 INICIADOR DEDICADO DE SESIÓN DE BINANCE P2P             ');
    console.log('=============================================================\n');

    const config = loadEnv();
    const username = config.BINANCE_USUARIO;
    const password = config.BINANCE_CLAVE;

    const userDataDir = path.join(__dirname, '../binance_edge_profile');

    console.log('🌐 Abriendo Microsoft Edge con perfil persistente para guardar tu sesión...');
    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'msedge', // Utilizar Microsoft Edge oficial
        headless: false,
        slowMo: 100,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await context.newPage();

    console.log('Navegando a la página de login de Binance...');
    await page.goto('https://www.binance.com/es/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    try {
        if (username && (await page.$('input[name="email"], input[type="email"]'))) {
            console.log(`Auto-completando correo (${username})...`);
            await page.fill('input[name="email"], input[type="email"]', username);
            await page.click('button#login_input_login_next_button, button[type="submit"]');
            await page.waitForTimeout(2000);
        }
        if (password && (await page.$('input[type="password"]'))) {
            console.log('Auto-completando contraseña...');
            await page.fill('input[type="password"]', password);
            await page.click('button[type="submit"]');
        }
    } catch (e) {}

    console.log('\n=============================================================');
    console.log('📌 INSTRUCCIONES EN PANTALLA:');
    console.log('Por favor completa el código por Correo/SMS o la Verificación Facial en la ventana del navegador.');
    console.log('El script detectará automáticamente en cuanto entres a tu cuenta.');
    console.log('=============================================================\n');

    // Esperar de forma activa hasta que el usuario se encuentre dentro de la zona autenticada
    let isAuthenticated = false;
    for (let i = 0; i < 150; i++) { // Espera de hasta 5 minutos
        await page.waitForTimeout(2000);
        const url = page.url();
        if (!url.includes('/login') && !url.includes('/security') && !url.includes('/mfa')) {
            console.log(`🎉 ¡Login autenticado detectado en: ${url}!`);
            isAuthenticated = true;
            break;
        }
    }

    if (isAuthenticated) {
        console.log('Navegando a la Billetera de Fondos para sincronizar tokens de saldo...');
        await page.goto('https://www.binance.com/es/my/wallet/account/funding', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForTimeout(6000);
    }

    await context.storageState({ path: BINANCE_SESSION });
    console.log(`\n✅ ¡Sesión AUTENTICADA guardada con éxito en: ${BINANCE_SESSION}!`);

    await browser.close();
    console.log('Iniciador de sesión finalizado.');
}

if (require.main === module) {
    initBinanceSessionDedicated().catch(err => console.error('Error:', err));
}

module.exports = { initBinanceSessionDedicated, BINANCE_SESSION };
