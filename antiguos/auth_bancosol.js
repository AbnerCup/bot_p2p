const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('--- Iniciador de Sesión de Banco Sol (SolNet) ---');

    let storageState = undefined;
    if (fs.existsSync(SOLNET_SESSION)) {
        console.log('Cargando sesión previa de Banco Sol...');
        storageState = SOLNET_SESSION;
    }

    const browser = await chromium.launch({
        headless: false, // Visible para que puedas interactuar
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        storageState: storageState,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    console.log('Conectando al portal de SolNet Persona (Banco Sol)...');
    await page.goto('https://solnet.bancosol.com.bo/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    console.log('\n=============================================================');
    console.log('Por favor ingresa a tu cuenta en la ventana del navegador.');
    console.log('El script esperará 60 segundos para sincronizar y guardar la sesión.');
    console.log('=============================================================\n');

    await page.waitForTimeout(60000);

    // Guardar cookies y estado de sesión
    await context.storageState({ path: SOLNET_SESSION });
    console.log(`\n✅ Sesión de Banco Sol guardada con éxito en: ${SOLNET_SESSION}`);

    await browser.close();
    console.log('Iniciador de Banco Sol finalizado.');
})();
