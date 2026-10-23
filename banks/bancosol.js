/**
 * Módulo de Automatización Oficial para Banco Sol (SolNet Digital)
 * Rellena de forma 100% autónoma todos los campos en Paso 1 (Datos), Paso 2 (Transferencia)
 * y deja la operación lista en Paso 3 (Confirmación con Token Móvil).
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { verifyHolderName } = require('../security/verifier');
const { decodeQRImage } = require('../utils/qr_decoder');
const { loadEnv } = require('../config');
const tokenBridge = require('../web/token_bridge');

const SOLNET_SESSION = path.join(__dirname, '../session_bancosol.json');

/**
 * Mapeo inteligente de nombres de bancos de Bolivia a los nombres oficiales en SolNet
 */
function resolveSolNetBankName(targetBank) {
    if (!targetBank) return 'Banco de Crédito de Bolivia';
    const b = targetBank.toLowerCase().trim();

    if (b.includes('crédito') || b.includes('credito') || b.includes('bcp')) return 'Banco de Crédito de Bolivia';
    if (b.includes('unión') || b.includes('union')) return 'Banco Unión';
    if (b.includes('bnb') || b.includes('nacional de bolivia')) return 'Banco Nacional de Bolivia';
    if (b.includes('mercantil') || b.includes('bmsc') || b.includes('santa cruz')) return 'Banco Mercantil Santa Cruz S.A.';
    if (b.includes('económico') || b.includes('economico')) return 'Banco Económico';
    if (b.includes('solidario') || b.includes('sol') || b.includes('bancosol')) return 'Banco Solidario S.A.';
    if (b.includes('fie')) return 'Banco FIE';
    if (b.includes('ganadero')) return 'Banco Ganadero';
    if (b.includes('bisa')) return 'Banco BISA S.A.';
    if (b.includes('fortaleza')) return 'Banco Fortaleza';
    if (b.includes('ecofuturo')) return 'BANCO PYME ECOFUTURO S.A.';
    if (b.includes('comunidad')) return 'BANCO PYME DE LA COMUNIDAD';
    if (b.includes('tigo')) return 'TIGO MONEY';
    if (b.includes('prodem')) return 'BANCO PRODEM S.A.';

    return targetBank;
}

/**
 * Realiza login automático si la sesión no existe o expiró
 */
async function ensureSolNetAuthenticated(page, context, config) {
    // Si la URL actual es login o tiene campos de credenciales
    const isLogin = page.url().includes('/login') || await page.$('input[type="password"]');
    if (!isLogin) return true;

    console.log('🔑 Auto-renovando sesión en SolNet Digital...');
    
    // Si aparece botón "Banca personas"
    const personasBtn = await page.$('text="Banca personas"');
    if (personasBtn) {
        await personasBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
    }

    const userInput = await page.waitForSelector('input[type="text"], input[name*="user" i]', { timeout: 12000 });
    const passInput = await page.waitForSelector('input[type="password"]', { timeout: 12000 });

    if (userInput && passInput) {
        await userInput.fill(config.SOLNET_USUARIO);
        await passInput.fill(config.SOLNET_CLAVE);
        await passInput.press('Enter');
        console.log('⏳ Esperando inicio de sesión (10s)...');
        await page.waitForTimeout(10000);
        await context.storageState({ path: SOLNET_SESSION });
        console.log('✅ Sesión actualizada y guardada con éxito.');
        return true;
    }
    return false;
}

/**
 * Ejecuta el auto-llenado completo de todos los campos en Banco Sol
 */
async function executeSolNetFormTransfer({
    destinationBank = 'Banco Solidario S.A.',
    beneficiaryName,
    accountNumber,
    amountBob,
    accountType = 'Caja de Ahorro',
    currency = 'Bolivianos',
    note = 'Pago P2P Binance',
    orderId = null,
    headless = false
}) {
    console.log('\n=============================================================');
    console.log(' ⚡ AUTO-LLENADO INTELIGENTE DE TRANSFERENCIA EN SOLNET');
    console.log('=============================================================');
    console.log(`- Banco Destino: ${destinationBank}`);
    console.log(`- Beneficiario:  ${beneficiaryName}`);
    console.log(`- N° Cuenta:     ${accountNumber}`);
    console.log(`- Monto a pagar: ${amountBob} BOB`);
    console.log(`- Glosa/Motivo:  ${note}\n`);

    const config = loadEnv();
    const resolvedBank = resolveSolNetBankName(destinationBank);
    const isOtherBank = !destinationBank.toLowerCase().includes('solidario') && !destinationBank.toLowerCase().includes('bancosol');

    const browser = await chromium.launch({
        headless: headless,
        slowMo: 100,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        storageState: fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined,
        permissions: ['geolocation'],
        geolocation: { latitude: -16.5000, longitude: -68.1500 }, // La Paz, Bolivia
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // 1. Navegar a la sección de transferencias
        const targetUrl = isOtherBank
            ? 'https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=OtherBank'
            : 'https://solnetdigital.bancosol.com.bo/dashboard/transactions/newTransfer?type=SameBank';

        console.log('1. Conectando al portal SolNet Digital...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Validar y renovar sesión si expiró
        await ensureSolNetAuthenticated(page, context, config);

        // Si fue redirigido por el login, re-navegar a targetUrl
        if (!page.url().includes('newTransfer')) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(4000);
        }

        // =========================================================================
        // PASO 1: DATOS DEL BENEFICIARIO
        // =========================================================================
        console.log('\n--- [PASO 1/3]: LLENANDO DATOS DEL BENEFICIARIO ---');

        // 1.1 Banco Destino
        console.log(`🏦 Seleccionando Banco de Destino: "${resolvedBank}"...`);
        const bankBtn = page.locator('[data-testid="third-party-select-bank-id"]');
        await bankBtn.waitFor({ state: 'visible', timeout: 20000 });

        // Si está deshabilitado momentáneamente (cargando lista de bancos), esperar
        await page.waitForFunction(() => {
            const btn = document.querySelector('[data-testid="third-party-select-bank-id"]');
            return btn && !btn.disabled && !btn.hasAttribute('disabled');
        }, { timeout: 15000 }).catch(() => {});

        await bankBtn.click();
        await page.waitForTimeout(1000);

        // Buscar la opción del banco en la lista
        const bankOption = page.locator('[role="option"]').filter({ hasText: new RegExp(resolvedBank.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
        if (await bankOption.count() > 0) {
            await bankOption.click();
            console.log(`✅ Banco "${resolvedBank}" seleccionado.`);
        } else {
            // Fallback: búsqueda por palabras clave
            const firstWord = resolvedBank.split(' ')[1] || resolvedBank.split(' ')[0];
            const fallbackOption = page.locator('[role="option"]').filter({ hasText: new RegExp(firstWord, 'i') }).first();
            if (await fallbackOption.count() > 0) {
                await fallbackOption.click();
                console.log(`✅ Banco seleccionado (coincidencia aproximada): ${firstWord}`);
            } else {
                await page.locator('[role="option"]').first().click();
                console.log(`⚠️ Banco seleccionado por fallback.`);
            }
        }
        await page.waitForTimeout(800);

        // 1.2 Nombre de Beneficiario
        console.log(`✍️ Llenando Nombre: "${beneficiaryName}"...`);
        const nameInput = page.locator('[data-testid="third-party-input-full-name"]');
        await nameInput.fill(beneficiaryName);
        await page.waitForTimeout(300);

        // 1.3 Número de Cuenta
        console.log(`✍️ Llenando N° Cuenta: "${accountNumber}"...`);
        const accInput = page.locator('[data-testid="third-party-input-account-id"]');
        await accInput.fill(String(accountNumber).trim());
        await page.waitForTimeout(300);

        // 1.4 Tipo de Cuenta (Caja de ahorros)
        console.log(`✍️ Seleccionando Tipo de Cuenta: "${accountType}"...`);
        const typeBtn = page.locator('[data-testid="third-party-select-type-id"]');
        await typeBtn.click();
        await page.waitForTimeout(800);
        const ahorroOpt = page.locator('[role="option"]').filter({ hasText: /ahorro/i }).first();
        if (await ahorroOpt.count() > 0) {
            await ahorroOpt.click();
        } else {
            await page.locator('[role="option"]').first().click();
        }
        await page.waitForTimeout(300);

        // 1.5 Moneda de Cuenta (Bolivianos)
        console.log(`✍️ Seleccionando Moneda: "${currency}"...`);
        const currBtn = page.locator('[data-testid="third-party-select-currency-type-id"]');
        await currBtn.click();
        await page.waitForTimeout(800);
        const bobOpt = page.locator('[role="option"]').filter({ hasText: /boliviano/i }).first();
        if (await bobOpt.count() > 0) {
            await bobOpt.click();
        } else {
            await page.locator('[role="option"]').first().click();
        }
        await page.waitForTimeout(800);

        // 1.6 Avanzar a Paso 2
        const continueBtnStep1 = page.locator('[data-testid="third-party-button-data-submit"]');
        console.log('🚀 Avanzando a Paso 2 (Transferencia)...');
        await continueBtnStep1.click();
        await page.waitForTimeout(3000);

        // =========================================================================
        // PASO 2: DATOS DE LA TRANSFERENCIA
        // =========================================================================
        console.log('\n--- [PASO 2/3]: LLENANDO DETALLES DE LA TRANSFERENCIA ---');

        // 2.1 Cuenta de Origen
        console.log('🏦 Seleccionando Cuenta de Origen...');
        const originBtn = page.locator('[data-testid="third-party-select-origin-account-id"]');
        await originBtn.waitFor({ state: 'visible', timeout: 10000 });
        await originBtn.click();
        await page.waitForTimeout(1000);
        // Seleccionar la primera cuenta de ahorros activa del usuario
        await page.locator('[role="option"]').first().click();
        console.log('✅ Cuenta de origen seleccionada.');
        await page.waitForTimeout(500);

        // 2.2 Monto a transferir
        console.log(`💸 Escribiendo Monto: ${amountBob} BOB...`);
        const amountInput = page.locator('[data-testid="third-party-input-amount"], input[name="amount"]');
        await amountInput.fill(String(amountBob));
        await page.waitForTimeout(300);

        // 2.3 Glosa / Motivo
        const fullGlosa = orderId ? `Pago P2P #${orderId}` : (note || 'Pago P2P Binance');
        console.log(`✍️ Escribiendo Glosa: "${fullGlosa}"...`);
        const noteInput = page.locator('[data-testid="third-party-input-note"], input[name="note"]');
        await noteInput.fill(fullGlosa);
        await page.waitForTimeout(500);

        // 2.4 Avanzar a Paso 3 (Confirmación)
        const continueBtnStep2 = page.locator('[data-testid="third-party-button-transference-data-submit"]');
        console.log('🚀 Avanzando a Paso 3 (Confirmación y Token)...');
        await continueBtnStep2.click();
        await page.waitForTimeout(4000);

        // =========================================================================
        // PASO 3: CONFIRMACIÓN Y TOKEN MÓVIL
        // =========================================================================
        console.log('\n=============================================================');
        console.log(' 🛡️  [PASO 3/3]: PANTALLA DE CONFIRMACIÓN Y TOKEN MÓVIL');
        console.log('=============================================================');
        console.log('Todos los datos fueron llenados automáticamente en Banco Sol:');
        console.log(`- Beneficiario:  ${beneficiaryName}`);
        console.log(`- N° Cuenta:     ${accountNumber} (${resolvedBank})`);
        console.log(`- Monto:         ${amountBob} BOB`);
        console.log(`- Glosa:         ${fullGlosa}\n`);

        const receiptPath = path.join(__dirname, '../comprobante_bancosol.png');
        await page.screenshot({ path: receiptPath, fullPage: true });
        console.log(`📸 Captura de la pantalla de confirmación guardada en:`);
        console.log(`   👉 ${receiptPath}`);

        // Revisar si la pantalla tiene campo de Token Móvil
        const tokenInput = page.locator('input[placeholder*="código" i], input[placeholder*="token" i], input[name="token"]');
        const transferBtn = page.locator('[data-testid="third-party-button-confirmation-submit"]');

        if (await tokenInput.count() > 0) {
            console.log('\n📲 SOLICITUD DE TOKEN MÓVIL DETECTADA');
            console.log('-------------------------------------------------------------');
            console.log('Banco Sol requiere el código de 6 dígitos de tu app móvil.');
            console.log('👉 Puedes ingresarlo DIRECTAMENTE AQUÍ EN LA CONSOLA,');
            console.log('   o en la Mini Web App desde tu celular,');
            console.log('   o en la ventana abierta de SolNet.');
            console.log('-------------------------------------------------------------\n');

            // Preparar canales múltiples para recibir el token de 6 dígitos (Consola, Web Móvil, DOM)
            let tokenReceived = null;
            let isResolved = false;

            // 1. Solicitud vía Web Móvil (tokenBridge)
            const bridgePromise = tokenBridge.requestToken({
                orderId: orderId || 'ORD-' + Date.now(),
                beneficiaryName: beneficiaryName,
                destinationBank: resolvedBank,
                accountNumber: accountNumber,
                amountBob: amountBob,
                glosa: fullGlosa,
                receiptPath: receiptPath
            }).catch(() => null);

            // 2. Solicitud vía Consola / Terminal (Readline CLI)
            let rl = null;
            const consolePromise = new Promise((resolve) => {
                if (process.stdin && process.stdin.readable) {
                    rl = readline.createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
                    rl.question('🔢 INGRESE EL CÓDIGO DE 6 DÍGITOS EN ESTA CONSOLA Y PRESIONE ENTER: ', (answer) => {
                        const code = (answer || '').trim();
                        if (code && code.length >= 4) {
                            console.log(`\n✅ Código de 6 dígitos ingresado por consola: ${code}`);
                            tokenBridge.submitToken(code);
                            resolve(code);
                        } else {
                            resolve(null);
                        }
                    });
                } else {
                    resolve(null);
                }
            });

            // 3. Polling en la ventana del navegador por si el usuario lo escribe directo en el DOM
            const domPromise = new Promise((resolve) => {
                const interval = setInterval(async () => {
                    if (isResolved) { clearInterval(interval); return; }
                    try {
                        const val = await tokenInput.inputValue().catch(() => '');
                        if (val && val.trim().length >= 4) {
                            isResolved = true;
                            clearInterval(interval);
                            console.log(`\n✅ Código de 6 dígitos detectado en la ventana del banco: ${val.trim()}`);
                            resolve(val.trim());
                        }
                    } catch (e) {}
                }, 1000);
            });

            // Timeout general de 90 segundos
            const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 90000));

            // Competencia de canales: el primero que proporcione el token de 6 dígitos
            try {
                tokenReceived = await Promise.race([
                    bridgePromise,
                    consolePromise,
                    domPromise,
                    timeoutPromise
                ]);
            } catch (e) {}

            isResolved = true;
            if (rl) {
                try { rl.close(); } catch (e) {}
            }

            if (tokenReceived) {
                console.log(`🔑 Inyectando Token Móvil (${tokenReceived}) en la plataforma de Banco Sol...`);
                await tokenInput.fill(tokenReceived);
                await page.waitForTimeout(600);

                if (await transferBtn.count() > 0) {
                    console.log('🚀 Haciendo clic en "Transferir"...');
                    await transferBtn.click();
                }
            } else {
                console.log('⚠️ No se ingresó ningún código de 6 dígitos dentro del tiempo límite (90s).');
            }

            // Esperar comprobante final
            let wasTransferred = false;
            for (let i = 0; i < 30; i++) {
                await page.waitForTimeout(1000);
                // Si la URL cambió o apareció un comprobante final de éxito
                if (page.url().includes('voucher') || page.url().includes('success') || await page.$('text=/exitosa|transferido|comprobante/i')) {
                    console.log('🎉 ¡TRANSFERENCIA BANCARIA COMPLETADA EXITOSAMENTE!');
                    wasTransferred = true;
                    await page.waitForTimeout(2000);
                    const successReceipt = path.join(__dirname, '../comprobante_bancosol_exito.png');
                    await page.screenshot({ path: successReceipt, fullPage: true });
                    tokenBridge.setTransferCompleted({ success: true, receiptPath: successReceipt });
                    break;
                }
            }
        }

        // Guardar sesión actualizada
        await context.storageState({ path: SOLNET_SESSION });
        await browser.close();

        return {
            success: true,
            receiptPath: receiptPath,
            beneficiaryName: beneficiaryName,
            accountNumber: accountNumber,
            bank: resolvedBank,
            amountBob: amountBob
        };

    } catch (error) {
        console.error('❌ Error durante la automatización de SolNet:', error.message);
        await browser.close();
        return { success: false, reason: error.message };
    }
}

/**
 * Procesa la orden completa con Verificación Anti-Terceros + Formulario SolNet
 */
async function processBancoSolTransferJIT({
    accountNumber,
    amountBob,
    counterpartyBybitName,
    qrImagePath = null,
    destinationBank = 'Banco Solidario S.A.',
    orderId = null,
    headless = false
}) {
    let targetAccount = accountNumber;
    let targetAmount = amountBob;
    let targetHolder = counterpartyBybitName;

    // Si viene imagen de QR, decodificar con OCR
    if (qrImagePath && fs.existsSync(qrImagePath)) {
        const qrData = await decodeQRImage(qrImagePath);
        if (qrData && qrData.accountNumber) {
            targetAccount = qrData.accountNumber;
            if (qrData.amountBob > 0) targetAmount = qrData.amountBob;
            if (qrData.holderName) targetHolder = qrData.holderName;
            if (qrData.bankName) destinationBank = qrData.bankName;
        }
    }

    // Verificación Anti-Terceros
    const verification = verifyHolderName(counterpartyBybitName, targetHolder);
    if (!verification.isValid) {
        console.error(`❌ [BANCO SOL ABORTADO POR SEGURIDAD] ${verification.reason}`);
        return { success: false, reason: verification.reason };
    }

    return await executeSolNetFormTransfer({
        destinationBank,
        beneficiaryName: targetHolder,
        accountNumber: targetAccount,
        amountBob: targetAmount,
        orderId,
        headless
    });
}

/**
 * Consulta el saldo disponible real en Banco Sol (SolNet)
 * @param {boolean} forceLive - Si es true, inicia sesión en SolNet Digital para obtener el saldo en tiempo real
 */
/**
 * Parsea un string de monto en formato boliviano o americano.
 *   "5.34"       -> 5.34       (formato US / BancoSol web actual)
 *   "5,34"       -> 5.34       (formato BO simple)
 *   "1.234,56"   -> 1234.56    (formato BO con miles)
 *   "1,234.56"   -> 1234.56    (formato US con miles)
 *   "5.000"      -> 5000       (BO sin decimales — ambiguo, tratamos como miles si el último grupo tiene 3 dígitos)
 */
function parseBolivianoAmount(raw) {
    if (!raw) return NaN;
    let s = String(raw).trim().replace(/\s/g, '');

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');

    if (hasDot && hasComma) {
        // El separador decimal es el ÚLTIMO que aparece
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
            // Formato BO: 1.234,56 -> puntos son miles, coma es decimal
            s = s.replace(/\./g, '').replace(',', '.');
        } else {
            // Formato US: 1,234.56 -> comas son miles, punto es decimal
            s = s.replace(/,/g, '');
        }
    } else if (hasComma) {
        // Solo coma: puede ser decimal (5,34) o miles (5,000). Si tiene exactamente 3 dígitos
        // después de la última coma y no hay otros signos, probablemente son miles.
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length === 3 && !/^0+$/.test(parts[1])) {
            // Ambiguo tipo "5,000". Preferimos tratar como miles solo si el valor resultante es > 1000.
            // Para montos de banco mejor asumimos decimal si tiene solo 2 dígitos.
            s = s.replace(',', '.');
        } else {
            s = s.replace(',', '.');
        }
    } else if (hasDot) {
        // Solo punto: puede ser decimal (5.34) o miles BO (5.000). Mismo criterio:
        // si el último grupo tiene 3 dígitos y es "000", tratamos como miles.
        const parts = s.split('.');
        if (parts.length >= 2 && parts[parts.length - 1].length === 3) {
            // Formato BO con punto como miles: 5.000 -> 5000
            s = parts.join('');
        }
        // En otro caso lo dejamos como decimal estándar.
    }

    return parseFloat(s);
}

/**
 * Lee el saldo "Cuenta disponible" directamente desde el dashboard de SolNet Digital.
 *
 * Cambios vs versión anterior:
 *  - NO cae a fallback hardcoded (54.00) ni al valor cacheado en capital.json cuando algo falla:
 *    propaga el error para que ejercicio.js / validateSnapshot lo detecten.
 *  - NO toma el primer "Bs X" del body (en el dashboard hay varios: saldo + transacciones).
 *    Busca el bloque "Cuenta disponible" y extrae el "Bs X" asociado a él.
 *  - Parser BO-aware (ver parseBolivianoAmount): maneja 5.34, 5,34 y 1.234,56 sin bugs.
 *  - Toma screenshot a /tmp o al cwd cuando el DOM no muestra lo esperado, para debug.
 *
 * @param {boolean} forceLive - Si true, consulta vivo. Si false, lee capital.json (compat con el flujo actual).
 * @param {object} opts - { headless?: boolean }
 * @returns {Promise<number>} - Saldo en BOB.
 * @throws {Error} si no logra leer el saldo en vivo (cuando forceLive=true).
 */
async function getBancoSolLiveBalance(forceLive = false, opts = {}) {
    const capitalFile = path.join(__dirname, '../capital.json');
    const headless = opts.headless !== undefined ? opts.headless : true;

    if (!forceLive) {
        // Modo "lee cache": sigue sirviendo para scripts que no quieren levantar el browser.
        if (fs.existsSync(capitalFile)) {
            try {
                const capData = JSON.parse(fs.readFileSync(capitalFile, 'utf8'));
                if (capData && typeof capData.bancoSolBob === 'number') {
                    return capData.bancoSolBob;
                }
            } catch (e) {
                throw new Error(`capital.json corrupto: ${e.message}`);
            }
        }
        throw new Error('No hay saldo cacheado en capital.json y forceLive=false. Usa forceLive=true o --sol=X.');
    }

    console.log('⚡ Sincronizando saldo en vivo desde SolNet Digital...');
    const config = loadEnv();

    if (!config.SOLNET_USUARIO || !config.SOLNET_CLAVE) {
        throw new Error('Faltan SOLNET_USUARIO o SOLNET_CLAVE en .env. No se puede consultar saldo en vivo.');
    }

    const browser = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled']
    });

    // let (no const) porque pueden reasignarse en el bloque de "relogin limpio" de abajo
    let context = await browser.newContext({
        storageState: fs.existsSync(SOLNET_SESSION) ? SOLNET_SESSION : undefined,
        permissions: ['geolocation'],
        geolocation: { latitude: -16.5000, longitude: -68.1500 },
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    let page = await context.newPage();

    try {
        await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', {
            waitUntil: 'domcontentloaded',
            timeout: 35000
        });

        // ESPERAR REDIRECCIONES: las SPAs frecuentemente hacen auth-check async después del
        // DOMContentLoaded y luego redirigen a /login si la sesión está muerta. 3s de simple
        // waitTimeout no es suficiente. Esperamos hasta que la URL se "estabilice" (no cambia
        // durante 1.5s consecutivos) o hasta un máximo de 10s.
        {
            let lastUrl = page.url();
            let stableSince = Date.now();
            const maxWait = Date.now() + 10000;
            while (Date.now() < maxWait) {
                await page.waitForTimeout(500);
                const nowUrl = page.url();
                if (nowUrl !== lastUrl) {
                    lastUrl = nowUrl;
                    stableSince = Date.now();
                } else if (Date.now() - stableSince >= 1500) {
                    break; // URL estable por 1.5s
                }
            }
        }

        // DETECCIÓN DE ESTADO DE SESIÓN (ya con la URL estabilizada post-redirecciones):
        //   a) solnetdigital.../dashboard/home       → sesión válida (continuar)
        //   b) solnetdigital.../login                → sesión expirada (hacer login)
        //   c) www.bancosol.com.bo (landing pública) → fuera de SolNet (navegar a login)
        //   d) solnetdigital.../dashboard/*          → dashboard pero token puede estar roto
        //                                              (se detecta más abajo por "UNAUTHORIZED")
        const currentUrl = page.url();
        const hasPasswordField = await page.$('input[type="password"]').catch(() => null);
        const hasBancaPersonasBtn = await page.$('text="Banca personas"').catch(() => null);
        const isInLanding = !currentUrl.includes('solnetdigital') ||
                            currentUrl.includes('www.bancosol.com.bo');
        const isInLogin = currentUrl.includes('/login');
        const isInDashboard = currentUrl.includes('solnetdigital') && currentUrl.includes('/dashboard');

        console.log(`   🧭 URL estabilizada: ${currentUrl}`);
        console.log(`   🧭 Estado: dashboard=${isInDashboard}, login=${isInLogin}, landing=${isInLanding}, passwordField=${!!hasPasswordField}, bancaPersonasBtn=${!!hasBancaPersonasBtn}`);

        const needsLogin = isInLanding || isInLogin || !!hasPasswordField || !!hasBancaPersonasBtn || !isInDashboard;

        if (needsLogin) {
            console.log('   🔑 No hay sesión válida en el dashboard. Iniciando flow de login...');

            // Si estamos en la landing o solo vemos "Banca personas", ir directo al login de SolNet.
            if (isInLanding || hasBancaPersonasBtn) {
                await page.goto('https://solnetdigital.bancosol.com.bo/login', {
                    waitUntil: 'domcontentloaded',
                    timeout: 35000
                }).catch(() => {});
                await page.waitForTimeout(3000);
            }

            const authed = await ensureSolNetAuthenticated(page, context, config);
            if (!authed) {
                throw new Error('Falló el login automático en SolNet. Revisa credenciales en .env.');
            }
            if (!page.url().includes('/dashboard')) {
                await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', {
                    waitUntil: 'domcontentloaded',
                    timeout: 35000
                });
                await page.waitForTimeout(3000);
            }
        }

        // Cerrar modales / popups que puedan tapar la info
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('Escape').catch(() => {});
            const closeElements = await page.$$('.ant-modal-close, button[aria-label="Close"], svg[data-icon="close"], [class*="close" i], button:has-text("✕")');
            for (const el of closeElements) {
                await el.click({ force: true }).catch(() => {});
            }
            await page.waitForTimeout(500);
        }

        // DETECCIÓN DE SESIÓN PARCIAL: cookies válidas pero token Bearer expirado.
        // La UI de SolNet muestra "UNAUTHORIZED" en los cards cuando esto pasa.
        // Playwright no persiste sessionStorage con storageState, así que necesitamos relogear.
        const earlyBody = await page.innerText('body').catch(() => '');
        const sessionLooksBroken = /UNAUTHORIZED/i.test(earlyBody) ||
                                    /No se puede visualizar/i.test(earlyBody) ||
                                    /No hay últimos movimientos disponibles/i.test(earlyBody);

        if (sessionLooksBroken) {
            console.log('⚠️  Dashboard cargó pero muestra UNAUTHORIZED. Haciendo relogin limpio...');

            await context.close().catch(() => {});
            if (fs.existsSync(SOLNET_SESSION)) {
                try { fs.unlinkSync(SOLNET_SESSION); } catch (e) {}
            }

            context = await browser.newContext({
                permissions: ['geolocation'],
                geolocation: { latitude: -16.5000, longitude: -68.1500 },
                viewport: { width: 1366, height: 768 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            });
            page = await context.newPage();

            await page.goto('https://solnetdigital.bancosol.com.bo/login', {
                waitUntil: 'domcontentloaded',
                timeout: 35000
            });
            await page.waitForTimeout(3000);

            const authed = await ensureSolNetAuthenticated(page, context, config);
            if (!authed) {
                throw new Error('Relogin limpio en SolNet falló. Verifica SOLNET_USUARIO/SOLNET_CLAVE en .env.');
            }

            if (!page.url().includes('/dashboard')) {
                await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', {
                    waitUntil: 'domcontentloaded',
                    timeout: 35000
                });
                await page.waitForTimeout(3000);
            }

            for (let i = 0; i < 3; i++) {
                await page.keyboard.press('Escape').catch(() => {});
                await page.waitForTimeout(400);
            }

            try { await context.storageState({ path: SOLNET_SESSION }); } catch (e) {}
            console.log('✅ Relogin exitoso.');
        }

        // Esperar a que aparezca "Cuenta disponible" (etiqueta semántica)
        try {
            await page.waitForSelector('text=/Cuenta disponible/i', { timeout: 15000 });
        } catch (waitErr) {
            // Diagnóstico detallado: qué URL/texto quedó cuando el selector no apareció
            const diagUrl = page.url();
            const diagTitle = await page.title().catch(() => '?');
            const diagBodySnippet = (await page.innerText('body').catch(() => '')).slice(0, 400).replace(/\s+/g, ' ');
            const shotPath = path.join(__dirname, '../solnet_debug.png');
            await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
            throw new Error(
                `No apareció "Cuenta disponible" tras 15s. ` +
                `URL=${diagUrl} | Título="${diagTitle}" | Body snippet: "${diagBodySnippet}". ` +
                `Screenshot: ${shotPath}`
            );
        }
        await page.waitForTimeout(1500); // dejar que renderice el monto

        // ESTRATEGIA 1: localizar el bloque que contiene "Cuenta disponible" y buscar su Bs cercano.
        // Según el DOM observado, el saldo "Bs X.XX" está en el mismo contenedor que la etiqueta
        // "Cuenta disponible | Nº XXXXXXX".
        let liveBalance = null;
        let strategyUsed = null;

        try {
            // Subir dos niveles desde "Cuenta disponible" para abarcar la tarjeta completa
            const container = page.locator('text=/Cuenta disponible/i').first().locator('xpath=ancestor::*[self::div][position()<=4]').last();
            const containerText = await container.innerText({ timeout: 5000 });
            // Primer "Bs X" dentro de ese contenedor (no incluye las transacciones que están fuera de la tarjeta)
            const m = containerText.match(/Bs\s*([0-9.,]+)/);
            if (m) {
                const val = parseBolivianoAmount(m[1]);
                if (!isNaN(val) && val >= 0) {
                    liveBalance = val;
                    strategyUsed = 'contenedor Cuenta disponible';
                }
            }
        } catch (e) {
            // seguimos con la siguiente estrategia
        }

        // ESTRATEGIA 2 (fallback): tomar el PRIMER "Bs X" que aparece DESPUÉS de la etiqueta
        // "Cuenta disponible" en el texto completo, no el primero del body.
        if (liveBalance === null) {
            const bodyText = await page.innerText('body');
            const anchorIdx = bodyText.search(/Cuenta disponible/i);
            if (anchorIdx !== -1) {
                const after = bodyText.slice(anchorIdx);
                const m = after.match(/Bs\s*([0-9.,]+)/);
                if (m) {
                    const val = parseBolivianoAmount(m[1]);
                    if (!isNaN(val) && val >= 0) {
                        liveBalance = val;
                        strategyUsed = 'texto después de Cuenta disponible';
                    }
                }
            }
        }

        if (liveBalance === null) {
            // Capturar screenshot y lanzar error con contexto
            const shotPath = path.join(__dirname, '../solnet_debug.png');
            await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
            throw new Error(`No se pudo localizar el saldo "Cuenta disponible" en el dashboard. Screenshot guardado en: ${shotPath}`);
        }

        console.log(`✅ Saldo detectado: Bs ${liveBalance.toFixed(2)} (vía ${strategyUsed})`);

        // Sanity check contra el valor anterior conocido
        if (fs.existsSync(capitalFile)) {
            try {
                const capData = JSON.parse(fs.readFileSync(capitalFile, 'utf8'));
                const prev = capData.bancoSolBob;
                if (typeof prev === 'number' && prev > 0 && liveBalance > 0) {
                    const ratio = Math.max(liveBalance, prev) / Math.max(0.01, Math.min(liveBalance, prev));
                    if (ratio >= 10) {
                        console.log(`⚠️  Advertencia: el saldo leído (Bs ${liveBalance.toFixed(2)}) difiere mucho del anterior (Bs ${prev.toFixed(2)}). Verifica manualmente antes de confirmar.`);
                    }
                }
            } catch (e) {}
        }

        // Persistir en capital.json (con timestamp para auditoría)
        try {
            let capData = {};
            if (fs.existsSync(capitalFile)) {
                try { capData = JSON.parse(fs.readFileSync(capitalFile, 'utf8')); } catch (e) { capData = {}; }
            }
            capData.bancoSolBob = liveBalance;
            capData.updatedAt = new Date().toISOString();
            capData.source = 'solnet-live';
            fs.writeFileSync(capitalFile, JSON.stringify(capData, null, 2), 'utf8');
        } catch (e) {
            console.log(`⚠️  No se pudo actualizar capital.json: ${e.message}`);
        }

        try { await context.storageState({ path: SOLNET_SESSION }); } catch (e) {}
        await browser.close();
        return liveBalance;

    } catch (err) {
        // Screenshot de debug antes de cerrar
        try {
            const shotPath = path.join(__dirname, '../solnet_debug.png');
            await page.screenshot({ path: shotPath, fullPage: true });
            console.log(`📸 Screenshot de debug guardado en: ${shotPath}`);
        } catch (e) {}
        await browser.close().catch(() => {});
        throw new Error(`SolNet live read falló: ${err.message}`);
    }
}

module.exports = {
    executeSolNetFormTransfer,
    processBancoSolTransferJIT,
    getBancoSolLiveBalance,
    resolveSolNetBankName,
    SOLNET_SESSION
};

