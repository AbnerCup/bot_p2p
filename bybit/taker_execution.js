/**
 * Módulo Ejecutor Semi-Automático de Pedidos Taker en Bybit P2P
 * Utiliza la sesión web existente (session_bybit.json) con Playwright.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '../session_bybit.json');

/**
 * Ejecuta un pedido como Taker en Bybit P2P
 * @param {Object} params
 * @param {'BUY'|'SELL'} params.side - 'BUY' para comprar USDT, 'SELL' para vender USDT
 * @param {string} params.merchantNick - Nombre del comerciante objetivo
 * @param {string|number} params.price - Precio del anuncio
 * @param {number} params.amountUsdt - Cantidad de USDT a operar (ej: 100)
 */
async function executeBybitTakerOrder({
    side = 'BUY',
    merchantNick = '',
    price = 0,
    amountUsdt = 100
}) {
    console.log('\n========================================================================');
    console.log(` ⚡ EJECUTANDO PEDIDO TAKER EN BYBIT P2P (${side === 'BUY' ? 'COMPRA' : 'VENTA'})`);
    console.log('========================================================================');
    console.log(`- Comerciante Destino: ${merchantNick || 'Mejor oferta disponible'}`);
    console.log(`- Precio Esperado:     ${price} BOB`);
    console.log(`- Monto a Operar:      ${amountUsdt} USDT`);
    console.log(`- Total Aproximado:    ${(amountUsdt * price).toFixed(2)} BOB\n`);

    let storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
    if (!storageState) {
        console.warn('⚠️ No se encontró session_bybit.json. Iniciando sin cookies de sesión.');
    }

    const browser = await chromium.launch({
        headless: false, // Visible para que el usuario supervise y proceda con el pago
        slowMo: 100,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ]
    });

    const context = await browser.newContext({
        storageState,
        viewport: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // actionType en Bybit OTC:
    // actionType=1: Comprar USDT (donde vemos anuncios de venta de otros)
    // actionType=0: Vender USDT (donde vemos anuncios de compra de otros)
    const actionType = side === 'BUY' ? '1' : '0';
    const targetUrl = `https://www.bybit.com/fiat/trade/otc/?actionType=${actionType}&token=USDT&fiat=BOB`;

    console.log(`🌐 Navegando a mercado P2P de Bybit (${side})...`);
    await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
    });

    await page.waitForTimeout(3000);

    try {
        console.log(`🔍 Localizando anuncio de "${merchantNick || 'la mejor oferta'}"...`);

        // Intentar encontrar la fila del comerciante o el primer botón de acción
        let targetBtn = null;
        if (merchantNick) {
            // Buscar la fila que contiene el nombre del comerciante
            const rowLocator = page.locator(`tr:has-text("${merchantNick}"), div[role="row"]:has-text("${merchantNick}")`).first();
            if (await rowLocator.count() > 0) {
                targetBtn = rowLocator.locator('button:has-text("Comprar"), button:has-text("Vender"), button:has-text("Buy"), button:has-text("Sell")').first();
            }
        }

        // Si no se encuentra por nombre o no se especificó, tomar el botón del primer anuncio de la lista
        if (!targetBtn || (await targetBtn.count() === 0)) {
            console.log('📌 Tomando la primera oferta en la parte superior del libro de órdenes...');
            targetBtn = page.locator('table tbody tr button, div[role="row"] button').filter({
                hasText: side === 'BUY' ? /Comprar|Buy/i : /Vender|Sell/i
            }).first();
        }

        if (await targetBtn.count() > 0) {
            console.log('👆 Abriendo formulario de la orden...');
            await targetBtn.click();
            await page.waitForTimeout(2000);

            // Localizar el campo de entrada de cantidad
            console.log(`✍️ Ingresando monto: ${amountUsdt} USDT...`);
            
            // Bybit suele tener 2 inputs: uno para moneda local (BOB) y otro para crypto (USDT)
            const usdtInput = page.locator('input[placeholder*="USDT"], input[placeholder*="Recibir"], input[placeholder*="Recibirás"], input[placeholder*="Cantidad"]').first();
            const fiatInput = page.locator('input[placeholder*="BOB"], input[placeholder*="Pagar"], input[placeholder*="Monto"]').first();

            if (await usdtInput.count() > 0 && await usdtInput.isVisible()) {
                await usdtInput.fill(String(amountUsdt));
            } else if (await fiatInput.count() > 0 && await fiatInput.isVisible()) {
                const totalBob = (amountUsdt * price).toFixed(2);
                await fiatInput.fill(String(totalBob));
            } else {
                // Selector genérico de input numérico en el modal/drawer
                const anyInput = page.locator('form input, div[role="dialog"] input, div.ant-drawer input').first();
                if (await anyInput.count() > 0) {
                    await anyInput.fill(String(amountUsdt));
                }
            }

            await page.waitForTimeout(1000);

            // Botón final de confirmación de la orden
            const confirmBtn = page.locator('button[type="submit"], div[role="dialog"] button, div.ant-drawer button').filter({
                hasText: side === 'BUY' ? /Comprar|Buy/i : /Vender|Sell/i
            }).last();

            if (await confirmBtn.count() > 0 && await confirmBtn.isEnabled()) {
                console.log('🚀 Enviando confirmación del pedido a Bybit P2P...');
                await confirmBtn.click();
                await page.waitForTimeout(3000);
                console.log('\n🎉 ¡PEDIDO CREADO EXITOSAMENTE EN BYBIT P2P!');
                console.log('⏱️ La ventana permanecerá abierta para que revises los datos de la contraparte y procedas con el pago.');
            } else {
                console.log('⚠️ Monto completado. Por favor presiona el botón de confirmación en la ventana del navegador.');
            }
        } else {
            console.warn('⚠️ No se pudo localizar el botón del anuncio automáticamente. Por favor selecciónalo en la ventana abierta.');
        }

    } catch (e) {
        console.error('ℹ️ Nota durante la automatización:', e.message);
        console.log('La ventana del navegador sigue abierta para que concluyas la orden manualmente.');
    }

    // Guardar estado de sesión actualizado
    try {
        await context.storageState({ path: SESSION_FILE });
    } catch (e) {}

    return { success: true };
}

module.exports = {
    executeBybitTakerOrder
};
