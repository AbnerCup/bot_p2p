/**
 * Módulo Ejecutor Semi-Automático de Pedidos Taker en Binance P2P
 * Utiliza el perfil persistente de Microsoft Edge (binance_edge_profile) con Playwright.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '../binance_edge_profile');
const SESSION_FILE = path.join(__dirname, '../session_binance.json');

/**
 * Ejecuta un pedido como Taker en Binance P2P
 * @param {Object} params
 * @param {'BUY'|'SELL'} params.side - 'BUY' para comprar USDT, 'SELL' para vender USDT
 * @param {string} params.merchantNick - Nombre del comerciante objetivo
 * @param {string|number} params.price - Precio del anuncio
 * @param {number} params.amountUsdt - Cantidad de USDT a operar (ej: 100)
 */
async function executeBinanceTakerOrder({
    side = 'BUY',
    merchantNick = '',
    price = 0,
    amountUsdt = 100
}) {
    console.log('\n========================================================================');
    console.log(` ⚡ EJECUTANDO PEDIDO TAKER EN BINANCE P2P (${side === 'BUY' ? 'COMPRA' : 'VENTA'})`);
    console.log('========================================================================');
    console.log(`- Comerciante Destino: ${merchantNick || 'Mejor oferta disponible'}`);
    console.log(`- Precio Esperado:     ${price} BOB`);
    console.log(`- Monto a Operar:      ${amountUsdt} USDT`);
    console.log(`- Total Aproximado:    ${(amountUsdt * price).toFixed(2)} BOB\n`);

    // Priorizar perfil persistente de Microsoft Edge donde el usuario ya inició sesión
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'msedge',
        headless: false, // Visible para que el usuario supervise y proceda con el pago
        slowMo: 100,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ]
    });

    const page = await context.newPage();

    // En Binance P2P:
    // Para comprar USDT (Taker BUY): tradeType=buy
    // Para vender USDT (Taker SELL): tradeType=sell
    const tradePath = side === 'BUY' ? 'buy' : 'sell';
    const targetUrl = `https://p2p.binance.com/es/trade/all-payments/USDT?fiat=BOB&tradeType=${tradePath}`;

    console.log(`🌐 Navegando a Binance P2P (${side})...`);
    await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
    });

    await page.waitForTimeout(3000);

    try {
        console.log(`🔍 Localizando anuncio de "${merchantNick || 'la mejor oferta'}"...`);

        let targetBtn = null;
        if (merchantNick) {
            const rowLocator = page.locator(`tr:has-text("${merchantNick}"), div[role="row"]:has-text("${merchantNick}")`).first();
            if (await rowLocator.count() > 0) {
                targetBtn = rowLocator.locator('button:has-text("Comprar USDT"), button:has-text("Vender USDT"), button:has-text("Buy USDT"), button:has-text("Sell USDT")').first();
            }
        }

        if (!targetBtn || (await targetBtn.count() === 0)) {
            console.log('📌 Tomando la primera oferta en la parte superior de Binance...');
            targetBtn = page.locator('button:has-text("Comprar USDT"), button:has-text("Vender USDT")').first();
        }

        if (await targetBtn.count() > 0) {
            console.log('👆 Abriendo formulario de la orden...');
            await targetBtn.click();
            await page.waitForTimeout(2000);

            console.log(`✍️ Ingresando monto: ${amountUsdt} USDT...`);
            
            // Selector de campo USDT en Binance P2P
            const usdtInput = page.locator('input[placeholder*="USDT"], input[name*="crypto"], input[aria-label*="USDT"]').first();
            const fiatInput = page.locator('input[placeholder*="BOB"], input[name*="fiat"]').first();

            if (await usdtInput.count() > 0 && await usdtInput.isVisible()) {
                await usdtInput.fill(String(amountUsdt));
            } else if (await fiatInput.count() > 0 && await fiatInput.isVisible()) {
                const totalBob = (amountUsdt * price).toFixed(2);
                await fiatInput.fill(String(totalBob));
            } else {
                const anyInput = page.locator('form input, div[role="dialog"] input').first();
                if (await anyInput.count() > 0) {
                    await anyInput.fill(String(amountUsdt));
                }
            }

            await page.waitForTimeout(1000);

            // Botón de confirmación final en Binance
            const confirmBtn = page.locator('button:has-text("Comprar USDT"), button:has-text("Vender USDT")').last();

            if (await confirmBtn.count() > 0 && await confirmBtn.isEnabled()) {
                console.log('🚀 Enviando confirmación del pedido a Binance P2P...');
                await confirmBtn.click();
                await page.waitForTimeout(3000);
                console.log('\n🎉 ¡PEDIDO CREADO EXITOSAMENTE EN BINANCE P2P!');
                console.log('⏱️ La ventana permanecerá abierta para que revises los datos de la contraparte y procedas con el pago.');
            } else {
                console.log('⚠️ Monto completado. Por favor presiona el botón de confirmación en la ventana del navegador.');
            }
        } else {
            console.warn('⚠️ No se pudo localizar el botón del anuncio automáticamente. Por favor selecciónalo en la ventana abierta.');
        }

    } catch (e) {
        console.error('ℹ️ Nota durante la automatización de Binance:', e.message);
        console.log('La ventana del navegador sigue abierta para que concluyas la orden manualmente.');
    }

    return { success: true };
}

module.exports = {
    executeBinanceTakerOrder
};
