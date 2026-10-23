const { chromium } = require('playwright');

(async () => {
  console.log('Iniciando navegador en modo visible...');
  
  // Lanzamos Chromium en modo visible (headless: false)
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100, // Hace que los movimientos y cargas sean visibles
    args: ['--disable-blink-features=AutomationControlled'] // Evita detección básica de bots
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  console.log('Navegando a Bybit P2P...');
  await page.goto('https://www.bybit.com/fiat/trade/otc/?actionType=1&token=USDT&fiat=BOB', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('Página cargada con éxito. La ventana permanecerá abierta 20 segundos para que veas el resultado.');
  
  // Esperar 20 segundos antes de cerrar
  await page.waitForTimeout(20000);

  await browser.close();
  console.log('Prueba finalizada.');
})();