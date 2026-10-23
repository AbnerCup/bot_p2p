const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('--- DIAGNOSTICANDO CAMPOS EN FORMULARIO OTROS BANCOS ---');
    const config = loadEnv();
    const storageState = fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined;

    const browser = await chromium.launch({ headless: false, slowMo: 100 });
    const context = await browser.newContext({
        storageState,
        viewport: { width: 1366, height: 768 }
    });
    const page = await context.newPage();

    try {
        console.log('1. Navegando a SolNet...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);

        if (page.url().includes('/login')) {
            console.log('🔑 Credenciales requeridas...');
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

        console.log('2. Inspeccionando elementos DOM...');
        const inputsInfo = await page.$$eval('input, textarea, select, [role], button', nodes => nodes.map(n => ({
            tag: n.tagName,
            type: n.type || null,
            placeholder: n.placeholder || null,
            name: n.name || null,
            id: n.id || null,
            text: n.innerText ? n.innerText.substring(0, 40) : null
        })));

        console.log('\n--- ELEMENTOS DETECTADOS EN LA PÁGINA ---');
        console.log(JSON.stringify(inputsInfo.filter(i => i.tag === 'INPUT' || i.placeholder || i.tag === 'BUTTON'), null, 2));

        const screenshotPath = path.join(__dirname, 'debug_otherbank_dom_fields.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`📸 Captura guardada en: ${screenshotPath}`);

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
})();
