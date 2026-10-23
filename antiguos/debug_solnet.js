const { chromium } = require('playwright');
const { loadEnv } = require('./config');

(async () => {
    console.log('--- DIAGNÓSTICO INTERACTIVO DE LOGIN Y NAVEGACIÓN DE SOLNET DIGITAL ---');
    const config = loadEnv();
    const username = config.SOLNET_USUARIO;
    const password = config.SOLNET_CLAVE;

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();

    console.log('Navegando a SolNet Digital...');
    await page.goto('https://solnetdigital.bancosol.com.bo/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (username && password) {
        console.log(`Rellenando usuario (${username}) y clave...`);
        try {
            await page.fill('input[type="text"], input[name*="user"], input[placeholder*="Usuario"]', username);
            await page.fill('input[type="password"]', password);
        } catch (e) {}
    }

    console.log('\n=============================================================');
    console.log('Por favor completa el inicio de sesión en la pantalla.');
    console.log('El script esperará 45 segundos para que estés en el Dashboard.');
    console.log('=============================================================\n');

    await page.waitForTimeout(45000);

    console.log('Navegando al formulario de transferencia...');
    await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=SameBank', { waitUntil: 'domcontentloaded' });

    await page.waitForTimeout(20000);

    await browser.close();
})();
