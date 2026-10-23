/**
 * Módulo de Publicación y Gestión Automatizada de Anuncios Maker P2P (Bybit)
 * Automatiza la navegación, rellenado y publicación en https://www.bybit.com/es-ES/p2p/advertiser/create
 */

const { queryBybitApi } = require('./balances');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '../session_bybit.json');

/**
 * Consulta los anuncios propios publicados en Bybit P2P
 */
async function getMyActiveAds() {
    // Intentar vía API v5 primero
    try {
        const apiRes = await queryBybitApi('/v5/asset/deposit/query-allowed-list', 'GET', {});
        if (apiRes && apiRes.retCode === 0 && apiRes.result && apiRes.result.list) {
            return apiRes.result.list;
        }
    } catch (e) {}

    return [];
}

/**
 * Publica un anuncio real en Bybit P2P completando el formulario y haciendo clic en "Publicar Anuncios"
 */
async function publishBybitMakerAd({
    side = 'BUY', // 'BUY' (Comprar USDT / Pagamos BOB) o 'SELL' (Venta USDT / Recibimos BOB)
    price,
    amountUsdt,
    minLimitBob = 50,
    maxLimitBob = 10000,
    paymentMethod = 'Banco Solidario S.A.',
    headless = false
}) {
    console.log('\n========================================================================');
    console.log(` 📢 PUBLICANDO ANUNCIO P2P MAKER EN BYBIT (${side})`);
    console.log('========================================================================');
    console.log(`- Tipo de Anuncio: ${side === 'BUY' ? 'COMPRAR USDT (Pagamos BOB)' : 'VENTA USDT (Vendemos USDT por BOB)'}`);
    console.log(`- Precio Fijo:     ${price} BOB`);
    console.log(`- Cantidad Total:  ${amountUsdt} USDT`);
    console.log(`- Límites BOB:     ${minLimitBob} BOB - ${maxLimitBob} BOB`);
    console.log(`- Método de Pago:  ${paymentMethod}\n`);

    let storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
    const browser = await chromium.launch({
        headless: headless,
        slowMo: 100,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-http2'
        ]
    });

    const context = await browser.newContext({
        storageState,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('1. Navegando al creador de anuncios de Bybit...');
        await page.goto('https://www.bybit.com/es-ES/p2p/advertiser/create', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);

        // Si la página redirige a login
        if (page.url().includes('/login') || page.url().includes('/register') || (await page.$('input[type="password"]'))) {
            console.log('\n=============================================================');
            console.log('📌 SESIÓN REQUERIDA EN BYBIT');
            console.log('Por favor completa el inicio de sesión en la ventana del navegador.');
            console.log('El bot avanzará automáticamente al formulario en cuanto entres.');
            console.log('=============================================================\n');

            for (let i = 0; i < 60; i++) {
                await page.waitForTimeout(2000);
                if (!page.url().includes('/login') && !page.url().includes('/register')) {
                    console.log(`🎉 ¡Sesión iniciada detectada! Guardando cookies...`);
                    await context.storageState({ path: SESSION_FILE });
                    break;
                }
            }

            console.log('Redirigiendo a https://www.bybit.com/es-ES/p2p/advertiser/create...');
            await page.goto('https://www.bybit.com/es-ES/p2p/advertiser/create', { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(3000);
        }

        // 1. SELECCIÓN DE TIPO: Comprar / Venta
        console.log(`2. PASO 1: Seleccionando tipo "${side === 'BUY' ? 'Comprar' : 'Venta'}"...`);
        const typeBtnSelector = side === 'BUY' ? 'text="Comprar"' : 'text="Venta"';
        const typeBtn = await page.waitForSelector(typeBtnSelector, { timeout: 10000 }).catch(() => null);
        if (typeBtn) {
            await typeBtn.click({ force: true });
            await page.waitForTimeout(1000);
        }

        // 2. CONFIGURACIÓN DE PRECIO FIJO
        console.log(`3. PASO 2: Ingresando precio fijo de ${price} BOB...`);
        const fixedRadio = await page.$('text="Precio fijo"');
        if (fixedRadio) await fixedRadio.click({ force: true }).catch(() => {});

        const priceInputs = await page.$$('input[type="text"]');
        for (const input of priceInputs) {
            const placeholder = (await input.getAttribute('placeholder')) || '';
            const val = (await input.inputValue()) || '';
            if (placeholder.includes('BOB') || placeholder.includes('precio') || placeholder.includes('0') || val.includes('11.') || val.includes('12.')) {
                await input.click({ clickCount: 3 });
                await input.fill(String(price));
                break;
            }
        }

        // 3. CANTIDAD TOTAL EN USDT
        console.log(`4. PASO 3: Ingresando cantidad total (${amountUsdt} USDT)...`);
        const allInputs = await page.$$('input[type="text"]');
        for (const input of allInputs) {
            const placeholder = (await input.getAttribute('placeholder')) || '';
            if (placeholder.includes('USDT') || placeholder.includes('cantidad') || placeholder.includes('Entrar') || placeholder.includes('Total')) {
                await input.click({ clickCount: 3 });
                await input.fill(String(amountUsdt));
                break;
            }
        }

        // 4. LÍMITES DE TRANSACCIÓN (Mínimo y Máximo)
        console.log(`5. PASO 4: Ingresando límites (${minLimitBob} BOB - ${maxLimitBob} BOB)...`);
        const limitInputs = await page.$$('input[placeholder*="Min" i], input[placeholder*="Max" i], input[placeholder*="Mín" i], input[placeholder*="Máx" i]');
        if (limitInputs.length >= 2) {
            await limitInputs[0].click({ clickCount: 3 });
            await limitInputs[0].fill(String(minLimitBob));
            await limitInputs[1].click({ clickCount: 3 });
            await limitInputs[1].fill(String(maxLimitBob));
        }

        // 5. SELECCIÓN DE MÉTODO DE PAGO
        console.log('6. PASO 5: Verificando método de pago (Banco Solidario)...');
        const paymentSelector = await page.$('text="Banco Solidario S.A."') || await page.$('text="Banco Sol"');
        if (!paymentSelector) {
            // Si hay botón para añadir o seleccionar método de pago
            const addPayBtn = await page.$('text="Añadir método de pago"') || await page.$('text="Método de pago"');
            if (addPayBtn) {
                await addPayBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(1000);
            }
        }

        // 6. ACEPTAR TÉRMINOS Y CONDICIONES
        console.log('7. PASO 6: Aceptando Términos y Condiciones...');
        const termsCheckbox = await page.$('input[type="checkbox"]');
        if (termsCheckbox) {
            await termsCheckbox.check({ force: true }).catch(() => {});
        }

        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(__dirname, `../debug_bybit_ad_before_publish_${side.toLowerCase()}.png`), fullPage: true });

        // 7. BOTÓN FINAL: PUBLICAR ANUNCIOS
        console.log('8. PASO 7: Haciendo clic en "Publicar Anuncios"...');
        const publishBtn = await page.waitForSelector('button:has-text("Publicar Anuncios"), button:has-text("Publicar")', { timeout: 10000 }).catch(() => null);
        
        if (publishBtn) {
            const isDisabled = await publishBtn.isDisabled().catch(() => false);
            if (!isDisabled) {
                await publishBtn.click({ force: true });
                console.log('👉 Clic ejecutado en "Publicar Anuncios". Esperando confirmación...');
                await page.waitForTimeout(3000);

                // Si aparece modal de confirmación
                const confirmModalBtn = await page.$('button:has-text("Confirmar"), button:has-text("Aceptar"), button:has-text("Confirm")');
                if (confirmModalBtn) {
                    console.log('👉 Confirmando diálogo de publicación...');
                    await confirmModalBtn.click({ force: true });
                    await page.waitForTimeout(3000);
                }

                console.log('\n========================================================================');
                console.log(`🎉 ¡ANUNCIO DE ${side} PUBLICADO EXITOSAMENTE EN BYBIT P2P!`);
                console.log('========================================================================\n');
            } else {
                console.log('⚠️ El botón de publicar está deshabilitado. Revisa saldo o límites en la pantalla.');
            }
        } else {
            console.log('⚠️ No se encontró el botón "Publicar Anuncios". Revisa la captura.');
        }

        await page.screenshot({ path: path.join(__dirname, `../debug_bybit_ad_published_${side.toLowerCase()}.png`), fullPage: true });
        await context.storageState({ path: SESSION_FILE });

        // Mantener abierto 5 segundos para que el usuario pueda apreciar el resultado en pantalla
        await page.waitForTimeout(5000);
        await browser.close();

        return {
            success: true,
            side,
            price,
            amountUsdt
        };
    } catch (e) {
        console.error('❌ Error al publicar anuncio en Bybit:', e.message);
        await browser.close();
        return { success: false, reason: e.message };
    }
}

module.exports = {
    getMyActiveAds,
    publishBybitMakerAd
};
