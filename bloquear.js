/**
 * GESTOR DE COMERCIANTES BLOQUEADOS / LISTA NEGRA BYBIT P2P
 * 
 * Permite bloquear, listar o desbloquear anunciantes para que el monitor,
 * el radar y los bots de arbitraje NUNCA los tomen en cuenta.
 * 
 * Uso:
 *   node bloquear.js "NombreComerciante"       (Bloquear uno)
 *   node bloquear.js "User1, User2, User3"     (Bloquear varios a la vez)
 *   node bloquear.js --list                    (Ver lista de bloqueados)
 *   node bloquear.js --remove "Nombre"         (Desbloquear)
 *   node bloquear.js                           (Modo interactivo)
 */

const readline = require('readline');
const args = process.argv.slice(2);
const isBinance = args.includes('--binance') || args.includes('-binance');

const {
    loadIgnoredMerchants,
    addIgnoredMerchant,
    removeIgnoredMerchant,
    IGNORED_MERCHANTS_BINANCE_FILE,
    IGNORED_MERCHANTS_FILE
} = isBinance ? require('./binance/eligibility') : require('./bybit/eligibility');

const activeFile = isBinance ? IGNORED_MERCHANTS_BINANCE_FILE : IGNORED_MERCHANTS_FILE;
const platformLabel = isBinance ? 'BINANCE' : 'BYBIT';

function printList() {
    const list = loadIgnoredMerchants();
    console.log('\n========================================================================');
    console.log(` 🚫 LISTA DE ANUNCIANTES BLOQUEADOS / IGNORADOS EN ${platformLabel} (${list.length})`);
    console.log('========================================================================');
    console.log(`📁 Archivo: ${activeFile}\n`);

    if (list.length === 0) {
        console.log('   (Actualmente no hay ningún comerciante bloqueado)');
    } else {
        list.forEach((nick, i) => {
            console.log(`   [#${i + 1}] ${nick} \x1b[31m\x1b[1m(bloq)\x1b[0m`);
        });
    }
    console.log('========================================================================\n');
}

async function main() {
    if (args.includes('--list') || args.includes('-l')) {
        printList();
        return;
    }

    const removeIdx = args.findIndex(a => a === '--remove' || a === '-r' || a === '--delete' || a === '-d');
    if (removeIdx !== -1) {
        const toRemove = args[removeIdx + 1];
        if (!toRemove) {
            console.error('❌ Debes especificar el nombre a remover. Ej: node bloquear.js --remove "Nombre"');
            return;
        }
        removeIgnoredMerchant(toRemove);
        console.log(`\n🔓 Comerciante "${toRemove}" desbloqueado y eliminado de la lista.`);
        printList();
        return;
    }

    // Argumentos directos pasados en CLI
    const namesToAdd = args.filter(a => !a.startsWith('-')).join(' ');
    if (namesToAdd.trim()) {
        const names = namesToAdd.split(',').map(n => n.trim()).filter(Boolean);
        names.forEach(name => {
            addIgnoredMerchant(name);
            console.log(`🚫 Comerciante "${name}" bloqueado exitosamente.`);
        });
        printList();
        return;
    }

    // Modo interactivo si no se pasaron argumentos
    printList();
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('Instrucciones:');
    console.log(' • Escribe el NOMBRE del anunciante que deseas bloquear.');
    console.log(' • Para bloquear varios a la vez, sepáralos con comas (ej: User1, User2).');
    console.log(' • Para desbloquear a alguien, antepón un guion (ej: -NOVATRAD).');
    console.log(' • Presiona ENTER vacío para salir.\n');

    rl.question('✏️  Nombre a bloquear/desbloquear: ', (answer) => {
        rl.close();
        const input = (answer || '').trim();
        if (!input) {
            console.log('Operación cancelada.');
            return;
        }

        if (input.startsWith('-')) {
            const toRemove = input.slice(1).trim();
            removeIgnoredMerchant(toRemove);
            console.log(`\n🔓 Comerciante "${toRemove}" desbloqueado.`);
        } else {
            const names = input.split(',').map(n => n.trim()).filter(Boolean);
            names.forEach(name => {
                addIgnoredMerchant(name);
                console.log(`\n🚫 Comerciante "${name}" bloqueado.`);
            });
        }
        printList();
    });
}

if (require.main === module) {
    main();
}

module.exports = {
    printList
};
