const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('--- TEST DE AUTO-LLENADO PASO A PASO EN SOLNET ---');
    const config = loadEnv();
    const browser = await chromium.launch({ headless: false, slowMo: 150 });
    const context = await browser.newContext({
        storageState: fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined,
        viewport: { width: 1366, height: 768 }
    });
    const page = await context.newPage();

    try {
        console.log('1. Navegando a Otros Bancos...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);

        if (page.url().includes('/login')) {
            console.log('🔑 Re-login requerida...');
            const u = (await page.$$('input'))[0];
            const p = (await page.$$('input'))[1];
            if (u && p) {
                await u.fill(config.SOLNET_USUARIO);
                await p.fill(config.SOLNET_CLAVE);
                await p.press('Enter');
            }
            await page.waitForTimeout(8000);
            await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank');
            await page.waitForTimeout(4000);
        }

        console.log('2. Haciendo click en el selector de Banco Destino...');
        const bankButton = await page.waitForSelector('button:has-text("Ingresa un banco"), button:has-text("Selecciona")', { timeout: 10000 });
        await bankButton.click();
        await page.waitForTimeout(1000);

        console.log('3. Seleccionando Banco de Crédito (BCP)...');
        const bcpItem = await page.waitForSelector('text=/crédito|credito|bcp/i, [role="option"]:has-text("Crédito")', { timeout: 10000 });
        await bcpItem.click();
        await page.waitForTimeout(1500);

        console.log('4. Rellenando Nombre de Beneficiario...');
        const nameInput = await page.waitForSelector('input[name="fullName"], input[placeholder*="nombre" i]', { timeout: 10000 });
        await nameInput.fill('COPA LOPEZ ABNER JOSE');

        console.log('5. Rellenando Número de Cuenta BCP...');
        const accInput = await page.waitForSelector('input[name="destinationAccountId"], input[placeholder*="cuenta" i]', { timeout: 10000 });
        await accInput.fill('40151438282343');

        console.log('6. Tomando captura de pantalla...');
        await page.screenshot({ path: path.join(__dirname, 'solnet_bcp_perfect_fill.png'), fullPage: true });

        console.log('✅ CAMPOS RELLENADOS CON ÉXITO.');
        await page.waitForTimeout(10000);
    } catch(e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
})();
