/**
 * Módulo de Alertas Sonoras de Alta Intensidad para Bot P2P
 * Compatible con Windows sin dependencias externas obligatorias.
 * 
 * Sonidos diferenciados:
 *  - BYBIT:   C:\Windows\Media\Alarm01.wav (Alarma tipo campana/chime ascendente)
 *  - BINANCE: C:\Windows\Media\Alarm02.wav (Alarma digital rítmica)
 * 
 * Soporta control de mute (silencio) con estado conmutable.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let lastSoundTime = 0;
const SOUND_COOLDOWN_MS = 2500; // Evitar saturación si el ciclo escanea cada 800ms

// Estado global de Mute (Silencio)
let isMuted = false;

// Rutas de alarmas oficiales de Windows
const SOUNDS = {
    bybit: 'C:\\Windows\\Media\\Alarm01.wav',
    binance: 'C:\\Windows\\Media\\Alarm02.wav',
    fallback: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
    chime: 'C:\\Windows\\Media\\chimes.wav'
};

/**
 * Obtiene la ruta de audio válida para una plataforma específica
 * @param {'bybit'|'binance'|string} platform
 * @returns {string}
 */
function getAlarmPathForPlatform(platform) {
    const platKey = (platform || '').toLowerCase();
    const candidate = SOUNDS[platKey] || SOUNDS.bybit;
    if (fs.existsSync(candidate)) {
        return candidate;
    }
    // Si no existe Alarm02, intentar Alarm03 o fallback
    if (platKey === 'binance' && fs.existsSync('C:\\Windows\\Media\\Alarm03.wav')) {
        return 'C:\\Windows\\Media\\Alarm03.wav';
    }
    if (fs.existsSync(SOUNDS.fallback)) {
        return SOUNDS.fallback;
    }
    return candidate;
}

/**
 * Comprueba si el sonido está silenciado (Mute ON)
 * @returns {boolean}
 */
function isSoundMuted() {
    return isMuted;
}

/**
 * Establece el estado de silencio (Mute)
 * @param {boolean} muted
 * @returns {boolean} Nuevo estado
 */
function setSoundMuted(muted) {
    isMuted = Boolean(muted);
    return isMuted;
}

/**
 * Alterna el estado de silencio (Switch Mute ON/OFF)
 * @returns {boolean} Nuevo estado (true = silenciado, false = activo)
 */
function toggleSoundMute() {
    isMuted = !isMuted;
    return isMuted;
}

/**
 * Reproduce un sonido de alarma sonoro y configurable
 * @param {Object} options
 * @param {'alarm'|'siren'|'chime'|'custom'} [options.type='alarm'] - Tipo de alarma
 * @param {'bybit'|'binance'|null} [options.platform=null] - Plataforma de origen
 * @param {string} [options.customPath] - Ruta a un archivo .wav o .mp3 personalizado
 * @param {boolean} [options.muted] - Sobrescribir estado de mute para esta llamada
 */
function playAlertSound({ type = 'alarm', platform = null, customPath = null, muted = null } = {}) {
    // Si está silenciado globalmente o por parámetro, no reproducir nada
    if (isMuted || muted === true) {
        return;
    }

    const now = Date.now();
    if (now - lastSoundTime < SOUND_COOLDOWN_MS) {
        return; // En enfriamiento para no solapar ruidos
    }
    lastSoundTime = now;

    try {
        // Opción 1: Archivo personalizado especificado por el usuario
        if (customPath && fs.existsSync(customPath)) {
            const ext = path.extname(customPath).toLowerCase();
            if (ext === '.wav') {
                const cmd = `powershell -c "(New-Object System.Media.SoundPlayer '${customPath}').PlaySync()"`;
                exec(cmd, { windowsHide: true }, () => {});
                return;
            } else {
                // Para .mp3 u otros formatos en Windows usando Windows Media Player en background
                const cmd = `powershell -c "$wmp = New-Object -ComObject WMPlayer.OCX; $wmp.URL = '${customPath}'; $wmp.controls.play(); Start-Sleep -Seconds 3"`;
                exec(cmd, { windowsHide: true }, () => {});
                return;
            }
        }

        // Opción 2: Sirena de Frecuencia Rápida (Pitidos diferenciados)
        if (type === 'siren') {
            const isBinance = (platform || '').toLowerCase() === 'binance';
            // Binance: Patrón alternante agudo-medio (2200Hz - 1700Hz)
            // Bybit: Patrón ascendente clásico (1200Hz -> 2400Hz)
            const beepCmd = isBinance
                ? `powershell -c "[Console]::Beep(2200, 120); [Console]::Beep(1700, 120); [Console]::Beep(2200, 120); [Console]::Beep(1700, 250)"`
                : `powershell -c "[Console]::Beep(1200, 120); [Console]::Beep(1600, 120); [Console]::Beep(2000, 120); [Console]::Beep(2400, 250)"`;
            
            exec(beepCmd, { windowsHide: true }, () => {});
            return;
        }

        // Opción 3: Chime / Ding alegre
        if (type === 'chime') {
            const chimePath = SOUNDS.chime;
            const cmd = `powershell -c "(New-Object System.Media.SoundPlayer '${chimePath}').PlaySync()"`;
            exec(cmd, { windowsHide: true }, () => {});
            return;
        }

        // Opción 4: Alarma oficial de Windows diferenciada:
        // - Bybit: Alarm01.wav
        // - Binance: Alarm02.wav
        const targetPath = getAlarmPathForPlatform(platform);

        const cmd = `powershell -c "(New-Object System.Media.SoundPlayer '${targetPath}').PlaySync()"`;
        exec(cmd, { windowsHide: true }, () => {});

    } catch (e) {
        // Fallback silencioso a campana ASCII estándar
        process.stdout.write('\x07\x07\x07');
    }
}

module.exports = {
    playAlertSound,
    isSoundMuted,
    setSoundMuted,
    toggleSoundMute,
    SOUNDS
};
