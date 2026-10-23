const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');
const CAPITAL_FILE = path.join(__dirname, 'capital.json');

async function ensureSolNetAuthenticated(page, context, config) {
    const isLogin = page.url().includes('/login') || await page.$('input[type="password"]');
    if (!isLogin) return true;

    console.log('🔑 Auto-renovando sesión en SolNet Digital...');
    
    const personasBtn = await page.$('text="Banca personas"');
    if (personasBtn) {
        await personasBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
    }

    const userInput = await page.waitForSelector('input[type="text"], input[name*="user" i]', { timeout: 12000 }).catch(() => null);
    const passInput = await page.waitForSelector('input[type="password"]', { timeout: 12000 }).catch(() => null);

    if (userInput && passInput) {
        await userInput.fill(config.SOLNET_USUARIO);
        await passInput.fill(config.SOLNET_CLAVE);
        await passInput.press('Enter');
        console.log('⏳ Esperando inicio de sesión (12s)...');
        await page.waitForTimeout(12000);
        await context.storageState({ path: SOLNET_SESSION });
        console.log('✅ Sesión actualizada y guardada con éxito.');
        return true;
    }
    return false;
}

(async () => {
    console.log('--- CONSULTANDO SALDO EN VIVO DE BANCO SOL ---');
    const config = loadEnv();

    const browser = await chromium.launch({
        headless: false, // Visible por si requiere resolver captcha o confirmación
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        storageState: fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined,
        permissions: ['geolocation'],
        geolocation: { latitude: -16.5000, longitude: -68.1500 },
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('1. Navegando a SolNet...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(3000);

        if (page.url().includes('/login') || await page.$('input[type="password"]')) {
            await ensureSolNetAuthenticated(page, context, config);
            if (!page.url().includes('/dashboard')) {
                await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', { waitUntil: 'domcontentloaded', timeout: 35000 });
                await page.waitForTimeout(4000);
            }
        }

        // Si hay modal emergente, cerrarlo
        const closeBtn = await page.$('button[aria-label="Close"], button:has-text("✕"), button:has-text("X"), .ant-modal-close, [class*="close" i], button:has-text("Calificar")');
        if (closeBtn) {
            console.log('Cerrando modal emergente...');
            // Intentar presionar la X
            const modalX = await page.$('.ant-modal-close, button[aria-label="Close"]');
            if (modalX) await modalX.click().catch(() => {});
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(1500);
        }

        await page.screenshot({ path: path.join(__dirname, 'debug_solnet_current_balance.png'), fullPage: true });

        const bodyText = await page.innerText('body');
        console.log('\n--- TEXTO EXTRAÍDO DE SOLNET ---');
        console.log(bodyText.substring(0, 1500));

        // Buscar montos en Bs: ej "Bs 4,209.75" o "Bs 4209.75"
        const regexBs = /Bs\s*([0-9.,]+)/g;
        let match;
        const foundBalances = [];
        while ((match = regexBs.exec(bodyText)) !== null) {
            const rawVal = match[1].replace(/,/g, '');
            const parsed = parseFloat(rawVal);
            if (!isNaN(parsed)) {
                foundBalances.push({ raw: match[0], val: parsed });
            }
        }

        console.log('\nSaldos encontrados en la pantalla:', foundBalances);

        if (foundBalances.length > 0) {
            // El primer o segundo balance suele ser el disponible de la caja de ahorro
            const detectedBalance = foundBalances[0].val;
            console.log(`\n🎉 Saldo detectado en Banco Sol: ${detectedBalance} BOB`);

            // Actualizar capital.json automáticamente
            if (fs.existsSync(CAPITAL_FILE)) {
                try {
                    const cap = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
                    cap.bancoSolBob = detectedBalance;
                    fs.writeFileSync(CAPITAL_FILE, JSON.stringify(cap, null, 2), 'utf8');
                    console.log(`✅ "capital.json" actualizado exitosamente con ${detectedBalance} BOB.`);
                } catch (e) {}
            }
        }

        await context.storageState({ path: SOLNET_SESSION });
        await browser.close();
    } catch (e) {
        console.error('Error al consultar saldo en Banco Sol:', e.message);
        await browser.close();
    }
})();
