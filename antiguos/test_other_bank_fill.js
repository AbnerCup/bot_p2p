const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('=============================================================');
    console.log(' ⚡ TEST DE FORMULARIO "A OTROS BANCOS" EN SOLNET DIGITAL');
    console.log('=============================================================');

    const config = loadEnv();
    const username = config.SOLNET_USUARIO;
    const password = config.SOLNET_CLAVE;

    let storageState = fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined;

    const browser = await chromium.launch({
        headless: false,
        slowMo: 150
    });

    const context = await browser.newContext({
        storageState,
        viewport: { width: 1366, height: 768 }
    });

    const page = await context.newPage();

    try {
        console.log('1. Abriendo SolNet Digital...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);

        // Si nos redirige a login
        if (page.url().includes('/login')) {
            console.log('🔑 Credenciales requeridas, iniciando sesión...');
            await page.waitForSelector('input', { timeout: 10000 });
            const loginInputs = await page.$$('input');
            if (loginInputs.length >= 2) {
                await loginInputs[0].fill(username);
                await loginInputs[1].fill(password);
            }
            await page.click('button[type="submit"], button:has-text("Ingresar"), button:has-text("Iniciar")');
            console.log('⏳ Esperando ingreso al dashboard...');
            await page.waitForTimeout(8000);

            // Re-navegar a Otros Bancos
            await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(4000);
        }

        console.log('2. Esperando renderizado de formulario "A otros bancos"...');
        await page.waitForSelector('input', { timeout: 20000 });
        await page.waitForTimeout(2000);

        // Inspeccionar todos los inputs
        const inputs = await page.$$('input');
        console.log(`📋 Inputs encontrados: ${inputs.length}`);

        // Inspeccionar dropdowns
        const comboboxes = await page.$$('[role="combobox"], select, div[class*="select"]');
        console.log(`📋 Dropdowns/Comboboxes encontrados: ${comboboxes.length}`);

        // Rellenar Nombre de Beneficiario y Número de Cuenta
        if (inputs.length >= 2) {
            console.log('✍️ Rellenando Beneficiario: JUAN PEREZ');
            await inputs[0].click();
            await inputs[0].fill('JUAN PEREZ');

            console.log('✍️ Rellenando N° Cuenta: 123456789');
            await inputs[1].click();
            await inputs[1].fill('123456789');
        }

        // Tomar captura del estado del formulario
        const screenshotPath = path.join(__dirname, 'solnet_otherbank_filled.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`📸 Captura guardada en: ${screenshotPath}`);

        // Guardar sesión actualizada
        await context.storageState({ path: SOLNET_SESSION });
        console.log('✅ Sesión de Banco Sol actualizada correctamente.');

    } catch (err) {
        console.error('❌ Error en prueba:', err.message);
    } finally {
        await page.waitForTimeout(5000);
        await browser.close();
    }
})();
