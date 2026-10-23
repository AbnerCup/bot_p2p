const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('🔍 INICIANDO INSPECCIÓN DE "TRANSFERENCIA A OTROS BANCOS" EN SOLNET...');

    const config = loadEnv();
    const username = config.SOLNET_USUARIO;
    const password = config.SOLNET_CLAVE;

    let storageState = fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined;

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100
    });

    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    try {
        console.log('1. Navegando a SolNet Login...');
        await page.goto('https://solnetdigital.bancosol.com.bo/login', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        if (page.url().includes('/login') || (await page.$('input[type="password"]'))) {
            console.log('🔑 Iniciando sesión...');
            const inputs = await page.$$('input');
            if (inputs.length >= 2) {
                await inputs[0].fill(username);
                await inputs[1].fill(password);
            }
            await page.click('button[type="submit"], button:has-text("Ingresar"), button:has-text("Iniciar")');
            await page.waitForTimeout(8000);
        }

        console.log('2. Navegando a Transferencias -> A otros bancos...');
        // Opción 1: Click directo si está en pantalla
        try {
            await page.click('text="A otros bancos"', { timeout: 5000 });
            console.log('✅ Click en botón "A otros bancos" realizado.');
        } catch (e) {
            console.log('⚠️ No se encontró botón texto "A otros bancos", forzando URL direct...');
            await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'domcontentloaded' });
        }

        await page.waitForTimeout(4000);
        await page.screenshot({ path: path.join(__dirname, 'solnet_otherbank_view.png'), fullPage: true });

        console.log('\n--- ELEMENTOS ENCONTRADOS EN LA PÁGINA ---');
        const inputs = await page.$$eval('input', nodes => nodes.map(n => ({
            type: n.type,
            placeholder: n.placeholder,
            id: n.id,
            name: n.name,
            value: n.value,
            outerHTML: n.outerHTML
        })));
        console.log('INPUTS:', JSON.stringify(inputs, null, 2));

        const dropdowns = await page.$$eval('select, div[role="combobox"], [class*="select"]', nodes => nodes.map(n => ({
            text: n.innerText,
            outerHTML: n.outerHTML
        })));
        console.log('DROPDOWNS/SELECTS:', JSON.stringify(dropdowns, null, 2));

        const labels = await page.$$eval('label, p, span, h1, h2, h3', nodes => nodes.map(n => n.innerText).filter(t => t && t.trim().length > 0));
        console.log('TEXTOS/LABELS:', labels.slice(0, 30));

        await context.storageState({ path: SOLNET_SESSION });
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await page.waitForTimeout(10000);
        await browser.close();
    }
})();
