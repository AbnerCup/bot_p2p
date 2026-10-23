const { chromium } = require('playwright');

(async () => {
    console.log('--- Iniciando lector de mercado Bybit P2P ---');

    const browser = await chromium.launch({
        headless: false, // Visible para que veas qué hace
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Interceptar las respuestas JSON de la API de Bybit P2P
    let apiData = null;
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/fiat/otc/item/online') || url.includes('/otc/item/list')) {
            try {
                const json = await response.json();
                if (json && json.result && (json.result.items || json.result)) {
                    apiData = json.result.items || json.result;
                }
            } catch (e) {}
        }
    });

    console.log('Conectando a Bybit P2P (BOB/USDT)...');
    await page.goto('https://www.bybit.com/fiat/trade/otc/?actionType=1&token=USDT&fiat=BOB', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    // Esperar a que cargue la lista o la API responda
    console.log('Esperando datos del mercado...');
    await page.waitForTimeout(5000);

    console.log('\n--- RESULTADOS DEL MERCADO P2P ---');
    if (apiData && Array.isArray(apiData) && apiData.length > 0) {
        console.log(`¡API detectada! Se obtuvieron ${apiData.length} anuncios oficiales:`);
        apiData.slice(0, 5).forEach((item, index) => {
            const nick = item.nickName || item.userNickName || 'Comerciante';
            const price = item.price;
            const lastQuantity = item.lastQuantity || item.quantity;
            const min = item.minAmount;
            const max = item.maxAmount;
            const payments = (item.payments || []).join(', ');
            console.log(`[#${index + 1}] ${nick} | Precio: ${price} BOB | Disp: ${lastQuantity} USDT | Lim: ${min}-${max} BOB | Pagos: ${payments}`);
        });
    } else {
        // Intento por DOM si la API cambió de endpoint
        const ads = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('tr, .trade-table__row, div[role="row"]'));
            return rows.map(r => r.innerText.replace(/\n+/g, ' | ')).filter(t => t.includes('BOB') || t.includes('Bs') || t.includes('USDT')).slice(0, 5);
        });

        if (ads.length > 0) {
            ads.forEach((ad, i) => console.log(`[#${i + 1}] ${ad}`));
        } else {
            console.log('Tomando captura para verificar estado...');
            await page.screenshot({ path: 'vista_bybit.png' });
        }
    }

    console.log('\nEsperando 3 segundos antes de cerrar...');
    await page.waitForTimeout(3000);

    await browser.close();
    console.log('Lector finalizado.');
})();