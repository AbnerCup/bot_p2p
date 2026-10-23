const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    console.log('--- INSPECCIONANDO Y SELECCIONANDO BANCO DESTINO (BCP) ---');
    const config = loadEnv();
    const storageState = fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined;

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100
    });

    const context = await browser.newContext({
        storageState,
        permissions: ['geolocation'],
        geolocation: { latitude: -16.5000, longitude: -68.1500 },
        viewport: { width: 1366, height: 768 }
    });

    let page = await context.newPage();

    try {
        console.log('1. Navegando a transferencias a otros bancos...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);

        if (page.url().includes('/login') || (await page.$('input[type="password"]'))) {
            console.log('🔑 Credenciales requeridas...');
            const userField = await page.$('input[type="text"]') || (await page.$$('input'))[0];
            const passField = await page.$('input[type="password"]') || (await page.$$('input'))[1];

            if (userField && passField) {
                await userField.fill(config.SOLNET_USUARIO);
                await passField.fill(config.SOLNET_CLAVE);
                await passField.press('Enter');
            }
            await page.waitForTimeout(10000);
            await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank');
            await page.waitForTimeout(4000);
        }

        console.log('2. Buscando dropdown de Banco de Destino...');
        await page.waitForSelector('input, [role="combobox"], button', { timeout: 15000 });

        // Tomar captura inicial del formulario
        await page.screenshot({ path: path.join(__dirname, 'solnet_form_before_dropdown.png'), fullPage: true });

        // Estrategia 1: Buscar combobox o disparador del select
        const dropdownTrigger = await page.$('[role="combobox"]') || 
                                await page.$('button[id*="bank" i]') || 
                                await page.$('div:has-text("Banco de destino") + div') || 
                                await page.$('label:has-text("Banco") + *') ||
                                (await page.$$('button'))[1]; // A veces el dropdown es un button

        if (dropdownTrigger) {
            console.log('📌 Disparador de dropdown encontrado. Haciendo click...');
            await dropdownTrigger.click({ force: true });
            await page.waitForTimeout(1500);

            // Buscar opción BCP o Banco de Crédito
            const bcpOption = await page.$('text=/crédito|credito|bcp/i') || 
                              await page.$('[role="option"]:has-text("Crédito")') ||
                              await page.$('div:has-text("BANCO DE CREDITO DE BOLIVIA")');

            if (bcpOption) {
                console.log('✅ Opción BCP encontrada. Seleccionando...');
                await bcpOption.click({ force: true });
            } else {
                console.log('⚠️ No se encontró la opción BCP en la lista visible. Inspeccionando opciones disponibles...');
                const allOptions = await page.$$eval('[role="option"], li, div[class*="option"]', nodes => nodes.map(n => n.innerText));
                console.log('Opciones disponibles:', allOptions);
            }
        } else {
            console.log('⚠️ No se encontró ningún disparador explícito de dropdown.');
        }

        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(__dirname, 'solnet_dropdown_selected.png'), fullPage: true });
        console.log('📸 Captura de pantalla guardada.');

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
})();
