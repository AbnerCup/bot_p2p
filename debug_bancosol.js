/**
 * Script de debug para SolNet Digital.
 * Abre el browser VISIBLE (no headless) para que puedas ver en pantalla
 * qué está pasando cuando Playwright intenta leer tu saldo.
 *
 * Uso:
 *   node debug_bancosol.js
 *
 * Qué hace:
 *  1. Abre Chromium con ventana visible y slowMo.
 *  2. Va al dashboard de SolNet.
 *  3. Si pide login, lo intenta con las credenciales de .env.
 *  4. Imprime la URL actual, el título, y todos los "Bs X" que encuentre
 *     con el texto que los rodea.
 *  5. Guarda screenshot `solnet_debug_visual.png`.
 *  6. Deja la ventana abierta 60 segundos para que puedas inspeccionar.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./config');

const SOLNET_SESSION = path.join(__dirname, 'session_bancosol.json');

(async () => {
    const config = loadEnv();

    console.log('========================================================');
    console.log(' 🔍 DEBUG BANCOSOL — ventana visible, 60s para inspeccionar');
    console.log('========================================================');
    console.log(` SOLNET_USUARIO en .env: ${config.SOLNET_USUARIO ? '✅ presente' : '❌ FALTA'}`);
    console.log(` SOLNET_CLAVE en .env:   ${config.SOLNET_CLAVE ? '✅ presente' : '❌ FALTA'}`);
    console.log(` session_bancosol.json:  ${fs.existsSync(SOLNET_SESSION) ? '✅ existe' : '❌ no existe (sin sesión guardada)'}`);
    console.log('--------------------------------------------------------\n');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 150,
        args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
    });

    const context = await browser.newContext({
        storageState: fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined,
        viewport: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('🌐 Navegando a dashboard de SolNet...');
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });
        await page.waitForTimeout(5000);

        console.log(`📍 URL actual: ${page.url()}`);
        console.log(`📄 Título: ${await page.title()}`);

        const hasPasswordField = await page.$('input[type="password"]');
        const isLoginUrl = page.url().includes('/login');
        console.log(`🔑 ¿En login? URL dice ${isLoginUrl}, campo password dice ${!!hasPasswordField}`);

        if (hasPasswordField || isLoginUrl) {
            console.log('\n⚡ Intentando autologin...');
            if (!config.SOLNET_USUARIO || !config.SOLNET_CLAVE) {
                console.log('❌ No hay credenciales en .env. Logueate MANUALMENTE en la ventana.');
                console.log('   Después presiona ENTER aquí para continuar.');
                await new Promise(r => process.stdin.once('data', r));
            } else {
                // Botón "Banca personas" si aparece
                const personasBtn = await page.$('text="Banca personas"');
                if (personasBtn) {
                    console.log('👉 Click en "Banca personas"');
                    await personasBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(2000);
                }

                const userInput = await page.waitForSelector('input[type="text"], input[name*="user" i]', { timeout: 10000 }).catch(() => null);
                const passInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => null);

                if (userInput && passInput) {
                    await userInput.fill(config.SOLNET_USUARIO);
                    await passInput.fill(config.SOLNET_CLAVE);
                    console.log('👉 Credenciales rellenadas, enviando...');
                    await passInput.press('Enter');
                    await page.waitForTimeout(10000);
                    console.log(`📍 URL tras login: ${page.url()}`);
                } else {
                    console.log('❌ No encontré los campos usuario/password. Logueate MANUALMENTE y presiona ENTER aquí.');
                    await new Promise(r => process.stdin.once('data', r));
                }
            }

            if (!page.url().includes('/dashboard')) {
                console.log('🔄 Yendo manualmente al dashboard...');
                await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', { waitUntil: 'domcontentloaded', timeout: 35000 });
                await page.waitForTimeout(5000);
            }
        }

        // Cerrar modales
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(400);
        }

        console.log('\n⏳ Esperando 5s más para que renderice todo...');
        await page.waitForTimeout(5000);

        console.log('\n========================================================');
        console.log(' 📊 ANÁLISIS DEL DOM VISIBLE');
        console.log('========================================================');

        const bodyText = await page.innerText('body');
        console.log(`\n📏 Longitud del body: ${bodyText.length} caracteres`);

        // Buscar palabras clave
        const keywords = ['Cuenta disponible', 'Mis cajas de ahorro', 'Hola,', 'Mis productos', 'Saldo', 'disponible'];
        console.log('\n🔎 Palabras clave encontradas:');
        for (const kw of keywords) {
            const idx = bodyText.toLowerCase().indexOf(kw.toLowerCase());
            console.log(`   ${idx !== -1 ? '✅' : '❌'} "${kw}"${idx !== -1 ? ` (posición ${idx})` : ''}`);
        }

        // Capturar TODOS los "Bs X" con contexto
        console.log('\n💰 Todos los montos "Bs X" encontrados (con 30 caracteres antes y después):');
        const regex = /Bs\s*([0-9.,]+)/g;
        let match;
        let count = 0;
        while ((match = regex.exec(bodyText)) !== null) {
            const start = Math.max(0, match.index - 30);
            const end = Math.min(bodyText.length, match.index + match[0].length + 30);
            const context = bodyText.slice(start, end).replace(/\n/g, ' ⏎ ');
            count++;
            console.log(`   [#${count}] "${match[0]}"  ⬅️  en contexto: "...${context}..."`);
        }
        if (count === 0) {
            console.log('   ❌ NO SE ENCONTRÓ NINGÚN "Bs X". El dashboard probablemente no cargó.');
        }

        const shotPath = path.join(__dirname, 'solnet_debug_visual.png');
        await page.screenshot({ path: shotPath, fullPage: true });
        console.log(`\n📸 Screenshot guardado en: ${shotPath}`);

        console.log('\n========================================================');
        console.log(' La ventana queda abierta 60s para que inspecciones.');
        console.log(' (Puedes abrir DevTools con F12, mover el mouse, etc.)');
        console.log('========================================================\n');
        await page.waitForTimeout(60000);

    } catch (err) {
        console.error('\n❌ Error:', err.message);
    } finally {
        try { await context.storageState({ path: SOLNET_SESSION }); } catch (e) {}
        await browser.close().catch(() => {});
        process.exit(0);
    }
})();
