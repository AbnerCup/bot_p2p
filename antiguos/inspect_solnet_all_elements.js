const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('🔍 DUMPING TODO EL DOM DE SOLNET DIGITAL...');
    const config = loadEnv();
    let storageState = fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined;

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ storageState, viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();

    try {
        console.log('Navegando a newTransfer?type=OtherBank...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(5000);

        if (page.url().includes('/login')) {
            console.log('Login requerido en prueba...');
            const u = config.SOLNET_USUARIO;
            const p = config.SOLNET_CLAVE;
            const userField = await page.$('input[type="text"]') || (await page.$$('input'))[0];
            const passField = await page.$('input[type="password"]') || (await page.$$('input'))[1];
            if (userField && passField) {
                await userField.fill(u);
                await passField.fill(p);
                await passField.press('Enter');
            }
            await page.waitForTimeout(8000);
            await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank');
            await page.waitForTimeout(5000);
        }

        console.log('Tomando captura completa...');
        await page.screenshot({ path: path.join(__dirname, 'dump_otherbank.png'), fullPage: true });

        const html = await page.content();
        fs.writeFileSync(path.join(__dirname, 'dom_dump.html'), html);
        console.log('HTML guardado en dom_dump.html');

        const inputsAndControls = await page.$$eval('input, textarea, select, [role], button', nodes => nodes.map(n => ({
            tag: n.tagName,
            type: n.type || null,
            placeholder: n.placeholder || null,
            id: n.id || null,
            name: n.name || null,
            role: n.getAttribute('role') || null,
            text: n.innerText ? n.innerText.substring(0, 30) : null
        })));

        console.log('\n--- INPUTS Y CONTROLES DETECTADOS ---');
        console.log(JSON.stringify(inputsAndControls, null, 2));

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
})();
