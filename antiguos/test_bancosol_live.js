const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

async function getLiveBancoSolBalance() {
    console.log('⚡ Consultando Banco Sol (SolNet Digital) en tiempo real...');
    const config = loadEnv();
    const username = config.SOLNET_USUARIO;
    const password = config.SOLNET_CLAVE;

    let storageState = fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined;

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        storageState: storageState,
        permissions: ['geolocation'],
        geolocation: { latitude: -16.5000, longitude: -68.1500 },
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    let page = await context.newPage();

    try {
        console.log('1. Conectando a SolNet Digital...');
        await page.goto('https://solnetdigital.bancosol.com.bo/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Click "Verificar nuevamente" or "Banca personas" if modal appears
        const verifyBtn = await page.$('button:has-text("Verificar nuevamente")');
        if (verifyBtn) {
            console.log('📌 Haciendo click en "Verificar nuevamente"...');
            await verifyBtn.click().catch(() => {});
            await page.waitForTimeout(2000);
        }

        const bancaPersonas = await page.$('text="Banca personas"');
        if (bancaPersonas) {
            console.log('📌 Seleccionando "Banca personas"...');
            await page.click('text="Banca personas"', { force: true }).catch(() => {});
            await page.waitForTimeout(4000);
            if (context.pages().length > 1) {
                page = context.pages()[context.pages().length - 1];
            }
        }

        const passField = await page.$('input[type="password"]');
        if (passField || page.url().includes('/login')) {
            console.log(`🔑 Rellenando credenciales para ${username}...`);
            const userField = await page.$('input[type="text"]') || (await page.$$('input'))[0];
            const pField = await page.$('input[type="password"]') || (await page.$$('input'))[1];

            if (userField && pField) {
                await userField.fill(username);
                await pField.fill(password);
                await page.waitForTimeout(500);
                await pField.press('Enter');
            }
            console.log('⏳ Esperando 12 segundos para carga completa del Dashboard...');
            await page.waitForTimeout(12000);
        }

        const screenshotPath = path.join(__dirname, 'debug_solnet_balance.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });

        const bodyText = await page.innerText('body');
        console.log('\n=============================================================');
        console.log(' 🏦 TEXTO EXTRAÍDO DEL BANCO SOL');
        console.log('=============================================================');
        console.log(bodyText.substring(0, 1500));

        await context.storageState({ path: SOLNET_SESSION });
        await browser.close();
        return bodyText;
    } catch(e) {
        console.error('Error al conectar con Banco Sol:', e.message);
        await browser.close();
        return null;
    }
}

if (require.main === module) {
    getLiveBancoSolBalance();
}

module.exports = { getLiveBancoSolBalance };
