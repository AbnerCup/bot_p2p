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
async function getBancoSolLiveBalance(forceLive = false) {
    const capitalFile = path.join(__dirname, '../capital.json');

    if (forceLive) {
        console.log('⚡ Sincronizando saldo en vivo desde SolNet Digital...');
        const config = loadEnv();
        const browser = await chromium.launch({
            headless: true,
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
            await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', { waitUntil: 'domcontentloaded', timeout: 35000 });
            await page.waitForTimeout(3000);

            if (page.url().includes('/login') || await page.$('input[type="password"]')) {
                await ensureSolNetAuthenticated(page, context, config);
                if (!page.url().includes('/dashboard')) {
                    await page.goto('https://solnetdigital.bancosol.com.bo/dashboard/home', { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(3000);
                }
            }

            for (let i = 0; i < 3; i++) {
                await page.keyboard.press('Escape').catch(() => {});
                const closeElements = await page.$$('.ant-modal-close, button[aria-label="Close"], svg[data-icon="close"], [class*="close" i], button:has-text("✕")');
                for (const el of closeElements) {
                    await el.click({ force: true }).catch(() => {});
                }
                await page.waitForTimeout(500);
            }

            // Esperar a que cargue la información de cuentas y saldo en el DOM
            await page.waitForSelector('text=/Cuenta disponible|Nº 4025413|Bs/i', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);

            const bodyText = await page.innerText('body');
            const regexBs = /Bs\s*([0-9.,]+)/g;
            let match;
            const found = [];
            while ((match = regexBs.exec(bodyText)) !== null) {
                const val = parseFloat(match[1].replace(/,/g, ''));
                if (!isNaN(val)) found.push(val);
            }

            if (found.length > 0) {
                const liveBalance = found[0];
                if (fs.existsSync(capitalFile)) {
                    try {
                        const capData = JSON.parse(fs.readFileSync(capitalFile, 'utf8'));
                        capData.bancoSolBob = liveBalance;
                        fs.writeFileSync(capitalFile, JSON.stringify(capData, null, 2), 'utf8');
                    } catch (e) {}
                }
                await context.storageState({ path: SOLNET_SESSION });
                await browser.close();
                return liveBalance;
            }

            await browser.close();
        } catch (e) {
            await browser.close().catch(() => {});
        }
    }

    let fallbackBalance = 54.00;
    if (fs.existsSync(capitalFile)) {
        try {
            const capData = JSON.parse(fs.readFileSync(capitalFile, 'utf8'));
            if (capData && typeof capData.bancoSolBob === 'number') {
                fallbackBalance = capData.bancoSolBob;
            }
        } catch (e) {}
    }

    return fallbackBalance;
}

module.exports = {
    executeSolNetFormTransfer,
    processBancoSolTransferJIT,
    getBancoSolLiveBalance,
    resolveSolNetBankName,
    SOLNET_SESSION
};

