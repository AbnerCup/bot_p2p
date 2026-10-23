/**
 * Módulo de Extracción de Datos de Orden y Chat de Binance P2P
 * Navega a https://c2c.binance.com/es/fiatOrderDetail?orderNo=...
 * Extrae:
 * 1. Datos bancarios oficiales de la orden (Titular, Banco, N° de Cuenta).
 * 2. Mensajes del chat en vivo y números de cuenta escritos.
 * 3. Descarga de imágenes y QRs adjuntos en el chat.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BINANCE_SESSION = path.join(__dirname, '../session_binance.json');
const ORDERS_DATA_DIR = path.join(__dirname, '../orders_data');

/**
 * Normaliza y detecta el banco boliviano a partir de texto
 */
function identifyBolivianBank(text) {
    if (!text) return 'Banco Solidario S.A.';
    const lower = text.toLowerCase();
    if (lower.includes('solidario') || lower.includes('sol')) return 'Banco Solidario S.A.';
    if (lower.includes('credito') || lower.includes('crédito') || lower.includes('bcp')) return 'Banco de Crédito de Bolivia S.A.';
    if (lower.includes('union') || lower.includes('unión')) return 'Banco Unión S.A.';
    if (lower.includes('mercantil') || lower.includes('bmsc')) return 'Banco Mercantil Santa Cruz S.A.';
    if (lower.includes('nacional') || lower.includes('bnb')) return 'Banco Nacional de Bolivia S.A.';
    if (lower.includes('ganadero')) return 'Banco Ganadero S.A.';
    if (lower.includes('fie')) return 'Banco FIE S.A.';
    if (lower.includes('economico') || lower.includes('económico')) return 'Banco Económico S.A.';
    if (lower.includes('prodem')) return 'Banco Prodem S.A.';
    if (lower.includes('fassil')) return 'Banco Fassil S.A.';
    return 'Banco Solidario S.A.';
}

/**
 * Obtiene el contexto del navegador intentando primero conectar al Microsoft Edge activo del usuario (CDP puerto 9222),
 * o en su defecto lanzando Microsoft Edge oficial con perfil persistente.
 */
async function getBinanceBrowserContext(headless = false) {
    // 1. Intentar conectar a Microsoft Edge activo vía CDP (puerto 9222)
    try {
        const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 1500 });
        console.log('🔗 ¡Conectado al navegador Microsoft Edge activo del usuario (vía CDP)!');
        const contexts = browser.contexts();
        const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        return { browser, context, isCDP: true };
    } catch (e) {
        // Fallback si no está abierto con remote debugging
    }

    // 2. Lanzar Microsoft Edge instalado con perfil persistente
    const userDataDir = path.join(__dirname, '../binance_edge_profile');
    console.log('🌐 Conectando mediante Microsoft Edge (canal oficial)...');
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'msedge', // Usa el ejecutable de Microsoft Edge del sistema
        headless: headless,
        slowMo: 100,
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: ['--disable-blink-features=AutomationControlled']
    });

    if (fs.existsSync(BINANCE_SESSION)) {
        try {
            const sessionData = JSON.parse(fs.readFileSync(BINANCE_SESSION, 'utf8'));
            if (sessionData.cookies) {
                await context.addCookies(sessionData.cookies);
            }
        } catch (e) {}
    }

    return { browser: context, context, isCDP: false };
}

/**
 * Abre la página de la orden de Binance y extrae todos los datos reales
 */
async function fetchBinanceOrderDetailsAndChat(orderNumber, headless = false) {
    console.log(`\n🔍 Abriendo orden Binance #${orderNumber} para extraer datos reales del pago y chat...`);

    if (!fs.existsSync(ORDERS_DATA_DIR)) {
        fs.mkdirSync(ORDERS_DATA_DIR, { recursive: true });
    }

    const orderFolder = path.join(ORDERS_DATA_DIR, String(orderNumber));
    if (!fs.existsSync(orderFolder)) {
        fs.mkdirSync(orderFolder, { recursive: true });
    }

    const { browser, context, isCDP } = await getBinanceBrowserContext(headless);
    const page = await context.newPage();

    try {
        const orderUrl = `https://c2c.binance.com/es/fiatOrderDetail?orderNo=${orderNumber}`;
        await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);

        // Si se redirige al login
        if (page.url().includes('/login')) {
            console.log('⚠️ Sesión requerida en Binance. Por favor inicia sesión en la ventana del navegador...');
            await page.waitForTimeout(20000);
            await context.storageState({ path: BINANCE_SESSION });
            // Re-navegar a la URL de la orden tras iniciar sesión
            await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(4000);
        }

        // Tomar captura de depuración de la orden
        const orderScreenshotPath = path.join(orderFolder, 'pantalla_orden.png');
        await page.screenshot({ path: orderScreenshotPath, fullPage: true });

        // 1. EXTRAER DATOS BANCARIOS OFICIALES DESDE LA PÁGINA
        console.log('📋 Extrayendo datos de la cuenta bancaria del vendedor...');
        
        const pageText = await page.innerText('body');
        
        // Buscar campos típicos de pago en Binance P2P
        let beneficiaryName = '';
        let accountNumber = '';
        let bankName = 'Banco Solidario S.A.';
        let amountBob = 0;

        // Extraer monto en BOB
        const amountMatch = pageText.match(/(?:Importe total|Monto a pagar|Total:?)\s*(?:Bs\.?|BOB)?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i) || 
                            pageText.match(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:Bs\.?|BOB)/i);
        if (amountMatch) {
            amountBob = parseFloat(amountMatch[1].replace(',', '.'));
        }

        // Extraer número de cuenta (8 a 16 dígitos numéricos)
        const accountMatch = pageText.match(/(?:N° de cuenta|Número de cuenta|Cuenta:?)\s*([0-9]{7,18})/i) ||
                             pageText.match(/\b([1-4][0-9]{7,15})\b/);
        if (accountMatch) {
            accountNumber = accountMatch[1];
        }

        // Extraer banco
        const detectedBank = identifyBolivianBank(pageText);
        if (detectedBank) bankName = detectedBank;

        // Extraer nombre del titular
        const nameMatch = pageText.match(/(?:Nombre del beneficiario|Titular|Nombre:?)\s*([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{4,35})/i);
        if (nameMatch) {
            beneficiaryName = nameMatch[1].trim();
        }

const { decodeQRImage } = require('../utils/qr_decoder');

        // 2. EXTRAER MENSAJES Y ELEMENTOS DEL CHAT
        console.log('💬 Extrayendo historial de mensajes y archivos del chat...');
        const chatMessages = [];
        const chatImages = [];
        let detectedQRData = null;
        let detectedQRPath = null;

        try {
            // Seleccionar elementos del chat
            const messageElements = await page.$$('[class*="chat"], [class*="message"], .chat-item, .im-msg-content, .bn-c2c-chat');
            for (const el of messageElements) {
                const text = (await el.innerText().catch(() => '')).trim();
                if (text && text.length > 1 && !chatMessages.includes(text)) {
                    chatMessages.push(text);
                    
                    // Si la contraparte escribió un número de cuenta en el chat
                    if (!accountNumber) {
                        const matchInChat = text.match(/\b([1-4][0-9]{7,15})\b/);
                        if (matchInChat) accountNumber = matchInChat[1];
                    }

                    // Si escribió el nombre del banco en el chat
                    const bankInChat = identifyBolivianBank(text);
                    if (bankInChat !== 'Banco Solidario S.A.') bankName = bankInChat;
                }
            }

            // Buscar imágenes enviadas en el chat (QRs o comprobantes)
            const imgElements = await page.$$('[class*="chat"] img, [class*="message"] img, .im-msg-content img, .bn-c2c-chat img, img[src*="c2c"], img[src*="oss"], img[src*="blob"], img[src*="upload"], img[src*="image"], [data-bn-type="img"]');
            let imgIndex = 0;
            for (const img of imgElements) {
                try {
                    const src = await img.getAttribute('src');
                    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('emoji') && !src.includes('logo')) {
                        const isVisible = await img.isVisible().catch(() => false);
                        if (!isVisible) continue;

                        imgIndex++;
                        const imgPath = path.join(orderFolder, `chat_adjunto_${imgIndex}.png`);
                        await img.scrollIntoViewIfNeeded().catch(() => {});
                        await page.waitForTimeout(300);
                        await img.screenshot({ path: imgPath });
                        chatImages.push(imgPath);
                        console.log(`📥 Imagen del chat guardada (${imgIndex}): ${imgPath}`);
                    }
                } catch (e) {}
            }

            // Si no se capturaron de imgElements, buscar contenedores de imágenes en el chat
            if (chatImages.length === 0) {
                const clickableImgs = await page.$$('[class*="chat"] [class*="image"], .im-msg-content [class*="image"], [class*="chat-item"] img');
                for (const el of clickableImgs) {
                    try {
                        imgIndex++;
                        const imgPath = path.join(orderFolder, `chat_adjunto_${imgIndex}.png`);
                        await el.scrollIntoViewIfNeeded().catch(() => {});
                        await el.screenshot({ path: imgPath });
                        chatImages.push(imgPath);
                        console.log(`📥 Captura de adjunto del chat guardada (${imgIndex}): ${imgPath}`);
                    } catch (e) {}
                }
            }

            // 3. DECODIFICAR CÓDIGOS QR Y EXTRAER DATOS CON OCR DE LAS IMÁGENES DEL CHAT
            for (const imgPath of chatImages) {
                console.log(`🔍 Escaneando imagen del chat en busca de Código QR / Datos: ${path.basename(imgPath)}...`);
                try {
                    const qrResult = await decodeQRImage(imgPath);
                    if (qrResult && (qrResult.accountNumber || qrResult.holderName || qrResult.raw)) {
                        console.log(`\n⚡ ¡CÓDIGO QR / DATOS DETECTADOS EXITOSAMENTE EN IMAGEN DEL CHAT!`);
                        if (qrResult.accountNumber) console.log(`   - N° Cuenta en QR: ${qrResult.accountNumber}`);
                        if (qrResult.holderName)    console.log(`   - Titular en QR:   ${qrResult.holderName}`);
                        if (qrResult.bankName)      console.log(`   - Banco en QR:     ${qrResult.bankName}`);
                        if (qrResult.amountBob > 0) console.log(`   - Monto en QR:     ${qrResult.amountBob} BOB`);

                        if (!accountNumber && qrResult.accountNumber) {
                            accountNumber = qrResult.accountNumber;
                        }
                        if (!beneficiaryName && qrResult.holderName) {
                            beneficiaryName = qrResult.holderName;
                        }
                        if ((bankName === 'Banco Solidario S.A.' || !bankName) && qrResult.bankName && qrResult.bankName !== 'SIMPLE QR BOLIVIA') {
                            bankName = qrResult.bankName;
                        }

                        detectedQRData = qrResult;
                        detectedQRPath = imgPath;
                    }
                } catch (qrErr) {
                    console.log(`⚠️ No se pudo decodificar QR en ${path.basename(imgPath)}: ${qrErr.message}`);
                }
            }
        } catch (e) {
            console.log(`ℹ️ Nota del chat: ${e.message}`);
        }

        console.log('\n=============================================================');
        console.log(' 📦 DATOS REALES EXTRAÍDOS DE LA ORDEN DE BINANCE:');
        console.log('=============================================================');
        console.log(`- Beneficiario:   ${beneficiaryName || 'Pendiente de confirmación'}`);
        console.log(`- Banco Destino:  ${bankName}`);
        console.log(`- N° Cuenta:      ${accountNumber || 'No detectada en texto'}`);
        console.log(`- Monto:          ${amountBob} BOB`);
        console.log(`- Mensajes Chat:  ${chatMessages.length} encontrados`);
        console.log(`- Imágenes Chat:  ${chatImages.length} descargadas`);
        if (detectedQRData) {
            console.log(`- Datos de QR:    Detectados y extraídos (${detectedQRData.accountNumber || 'OK'})`);
        }
        console.log('=============================================================\n');

        await context.storageState({ path: BINANCE_SESSION });
        await browser.close();

        return {
            success: true,
            orderNumber,
            beneficiaryName,
            bankName,
            accountNumber,
            amountBob,
            chatMessages,
            chatImages,
            detectedQRData,
            detectedQRPath,
            orderFolder
        };
    } catch (error) {
        console.error('Error al extraer datos de la orden en Binance:', error.message);
        await browser.close();
        return {
            success: false,
            error: error.message
        };
    }
}

const { getTodayQRPath } = require('../utils/qr_manager');

/**
 * Abre la orden en Binance P2P, envía el mensaje de bienvenida y adjunta la imagen del QR del día en el chat.
 */
async function sendBinanceOrderChatAndQR(orderNumber, customMessage = null, headless = false) {
    console.log(`\n💬 [BINANCE CHAT] Enviando mensaje y QR del día a la orden #${orderNumber}...`);
    const todayQRPath = getTodayQRPath();

    if (!todayQRPath || !fs.existsSync(todayQRPath)) {
        console.log('⚠️ No se encontró la imagen del QR del día en "qr_dia/qr_actual.png".');
        return { success: false, reason: 'QR no encontrado' };
    }

    const { browser, context, isCDP } = await getBinanceBrowserContext(headless);
    const page = await context.newPage();

    try {
        const orderUrl = `https://c2c.binance.com/es/fiatOrderDetail?orderNo=${orderNumber}`;
        await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);

        if (page.url().includes('/login')) {
            console.log('⚠️ Se requiere inicio de sesión en Binance. Por favor inicia sesión en la ventana del navegador...');
            await page.waitForTimeout(20000);
            await context.storageState({ path: BINANCE_SESSION });
            // Re-navegar a la URL de la orden tras iniciar sesión
            await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(4000);
        }

        const textToSend = customMessage || 
            'Hola, buenas. Te adjunto el código QR de cobro del día en este chat. Por favor realiza la transferencia exacta y asegúrate de que el titular coincida con tu usuario registrado en Binance.';

        // 1. Escribir mensaje en el chat
        console.log(`✍️ Escribiendo mensaje en el chat...`);
        const chatInput = page.locator('textarea, [placeholder*="mensaje" i], [placeholder*="message" i], div[contenteditable="true"]').first();
        if (await chatInput.count() > 0) {
            await chatInput.fill(textToSend);
            await page.waitForTimeout(500);
            await chatInput.press('Enter');
            console.log('✅ Mensaje de texto enviado al chat.');
            await page.waitForTimeout(1000);
        }

        // 2. Subir imagen del QR del día
        console.log(`🖼️ Adjuntando archivo de QR del día: ${todayQRPath}`);
        let qrAttached = false;

        // Estrategia A: Buscar selector de archivos input[type="file"] en el DOM (esperando si está adjunto)
        let fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});

        if (await fileInput.count() > 0) {
            try {
                await fileInput.setInputFiles(todayQRPath);
                qrAttached = true;
                console.log('✅ Imagen asignada a input[type="file"].');
            } catch (e) {
                console.log(`ℹ️ No se pudo cargar directamente en input[type="file"]: ${e.message}`);
            }
        }

        // Estrategia B: Buscar botones/iconos de adjuntar en el chat para disparar FileChooser
        if (!qrAttached) {
            const uploadBtnSelectors = [
                '[class*="attach" i]',
                '[class*="upload" i]',
                '[class*="img-upload" i]',
                'svg[class*="clip" i]',
                'button:has([class*="image" i])',
                '.chat-upload-icon',
                '[aria-label*="upload" i]',
                '[aria-label*="image" i]'
            ];

            for (const selector of uploadBtnSelectors) {
                const btn = page.locator(selector).first();
                if (await btn.count() > 0 && await btn.isVisible()) {
                    console.log(`📎 Intentando clic en botón de adjuntos (${selector})...`);
                    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
                    await btn.click().catch(() => {});
                    const fileChooser = await fileChooserPromise;
                    if (fileChooser) {
                        await fileChooser.setFiles(todayQRPath);
                        qrAttached = true;
                        console.log('✅ Archivo de QR cargado mediante FileChooser.');
                        break;
                    }
                }
            }
        }

        // Re-verificar si apareció input[type="file"] tras el clic
        if (!qrAttached) {
            fileInput = page.locator('input[type="file"]').first();
            if (await fileInput.count() > 0) {
                try {
                    await fileInput.setInputFiles(todayQRPath);
                    qrAttached = true;
                    console.log('✅ Archivo asignado tras activar panel de adjuntos.');
                } catch (e) {}
            }
        }

        if (qrAttached) {
            await page.waitForTimeout(2000);
            const sendBtn = page.locator('button:has-text("Enviar"), button:has-text("Send"), [class*="send" i], button[type="submit"]').first();
            if (await sendBtn.count() > 0 && await sendBtn.isVisible() && await sendBtn.isEnabled()) {
                await sendBtn.click();
                console.log('🚀 Clic en botón de envío de adjunto.');
            } else if (await chatInput.count() > 0) {
                await chatInput.press('Enter').catch(() => {});
            }
            await page.waitForTimeout(2500);
            console.log(`🎉 ¡QR del día enviado con éxito a la orden #${orderNumber}!`);
        } else {
            console.log('⚠️ No se pudo adjuntar el archivo de imagen en la pantalla del chat.');
        }

        await context.storageState({ path: BINANCE_SESSION });
        await browser.close();

        return {
            success: qrAttached,
            reason: qrAttached ? null : 'No se pudo adjuntar la imagen del QR en el chat de Binance.'
        };

    } catch (err) {
        console.error('❌ Error al enviar QR en el chat de Binance:', err.message);
        await browser.close();
        return { success: false, reason: err.message };
    }
}

module.exports = {
    fetchBinanceOrderDetailsAndChat,
    sendBinanceOrderChatAndQR,
    identifyBolivianBank,
    ORDERS_DATA_DIR
};
