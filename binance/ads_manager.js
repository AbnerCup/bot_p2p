/**
 * Módulo de Publicación y Gestión Automatizada de Anuncios Maker P2P (Binance)
 * Automatiza la navegación y rellenado en 3 pasos de c2c.binance.com/es/postAd
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { AD_TEMPLATES, calculateMakerPrices } = require('./templates');
const { scanBinanceP2PMarket } = require('./market');

const BINANCE_SESSION = path.join(__dirname, '../session_binance.json');

/**
 * Publica un Anuncio P2P Maker (COMPRA o VENTA) en Binance
 */
async function publishMakerAd({ type = 'BUY', customPrice = null, totalUsdtAmount = 10.00, minLimitBob = 55 }) {
    console.log('\n=============================================================');
    console.log(` 📢 PUBLICANDO ANUNCIO P2P MAKER EN BINANCE (${type})`);
    console.log('=============================================================');

    const template = type === 'BUY' ? AD_TEMPLATES.BUY : AD_TEMPLATES.SELL;
    
    // Obtener precios dinámicos según el mercado
    const market = await scanBinanceP2PMarket();
    const pricing = calculateMakerPrices(market);
    const targetPrice = customPrice || (type === 'BUY' ? pricing.buyPrice : pricing.sellPrice);

    console.log(`- Tipo de Anuncio: ${template.title}`);
    console.log(`- Precio a Publicar: ${targetPrice} BOB`);
    console.log(`- Cantidad Total: ${totalUsdtAmount} USDT`);
    console.log(`- Límite Mínimo: ${minLimitBob} BOB\n`);

    let storageState = fs.existsSync(BINANCE_SESSION) ? BINANCE_SESSION : undefined;

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        storageState,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('1. Navegando al panel de publicación de anuncios (https://c2c.binance.com/es/postAd)...');
        await page.goto('https://c2c.binance.com/es/postAd', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        // Si se requiere iniciar sesión en Binance
        if (page.url().includes('/login') || (await page.$('input[name="username"]'))) {
            console.log('📌 Sesión requerida en Binance. Esperando sincronización de usuario...');
            await page.waitForTimeout(15000);
        }

        // PASO 1: Establecer tipo y precio
        console.log(`2. PASO 1: Seleccionando tab "${type === 'BUY' ? 'Quiero comprar' : 'Quiero vender'}" y precio ${targetPrice} BOB...`);
        const tabSelector = type === 'BUY' ? 'text="Quiero comprar"' : 'text="Quiero vender"';
        const tabBtn = await page.waitForSelector(tabSelector, { timeout: 10000 }).catch(() => null);
        if (tabBtn) await tabBtn.click({ force: true });
        await page.waitForTimeout(1000);

        // Ingresar precio fijo
        const priceInput = await page.$('input[value*="12."], input[value*="10."], input[type="text"]') || (await page.$$('input'))[2];
        if (priceInput) {
            await priceInput.click({ clickCount: 3 });
            await priceInput.fill(String(targetPrice));
        }

        console.log('👉 Avanzando al Paso 2...');
        const nextBtn1 = await page.waitForSelector('button:has-text("Siguiente")', { timeout: 8000 });
        if (nextBtn1) await nextBtn1.click();
        await page.waitForTimeout(3000);

        // PASO 2: Importe total y límite de orden
        console.log(`3. PASO 2: Ingresando cantidad total (${totalUsdtAmount} USDT) y límites...`);
        const totalAmountInput = await page.waitForSelector('input[placeholder*="importe" i], input[placeholder*="cantidad" i]', { timeout: 8000 }).catch(() => null);
        if (totalAmountInput) {
            await totalAmountInput.fill(String(totalUsdtAmount));
        }

        console.log('👉 Avanzando al Paso 3...');
        const nextBtn2 = await page.waitForSelector('button:has-text("Siguiente")', { timeout: 8000 });
        if (nextBtn2) await nextBtn2.click();
        await page.waitForTimeout(3000);

        // PASO 3: Términos y Respuesta Automática
        console.log('4. PASO 3: Rellenando Términos del Anuncio y Respuesta Automática del Chat...');

        // Rellenar Términos / Comentarios
        const textareas = await page.$$('textarea');
        if (textareas.length >= 1) {
            console.log('✍️ Pegando Términos de Seguridad...');
            await textareas[0].fill(template.terms);
        }

        if (textareas.length >= 2) {
            console.log('✍️ Pegando Respuesta Automática de Bienvenida...');
            await textareas[1].fill(template.autoReply);
        }

        await page.screenshot({ path: path.join(__dirname, `../debug_ad_created_${type.toLowerCase()}.png`), fullPage: true });

        console.log('\n=============================================================');
        console.log(`✅ ANUNCIO (${type}) CONFIGURADO Y LISTO PARA PUBLICAR.`);
        console.log('=============================================================\n');

        await context.storageState({ path: BINANCE_SESSION });
        await browser.close();

        return {
            success: true,
            type: type,
            price: targetPrice,
            terms: template.terms,
            autoReply: template.autoReply
        };
    } catch(e) {
        console.error('Error al publicar anuncio en Binance:', e.message);
        await browser.close();
        return { success: false, reason: e.message };
    }
}

module.exports = {
    publishMakerAd
};
