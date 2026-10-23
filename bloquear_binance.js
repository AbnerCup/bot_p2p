/**
 * GESTOR DE COMERCIANTES BLOQUEADOS / LISTA NEGRA BINANCE P2P
 * 
 * Permite bloquear, listar o desbloquear anunciantes para que el radar
 * y los bots de arbitraje de Binance NUNCA los tomen en cuenta.
 * 
 * Uso:
 *   node bloquear_binance.js "NombreComerciante"       (Bloquear uno)
 *   node bloquear_binance.js "User1, User2, User3"     (Bloquear varios a la vez)
 *   node bloquear_binance.js --list                    (Ver lista de bloqueados)
 *   node bloquear_binance.js --remove "Nombre"         (Desbloquear)
 *   node bloquear_binance.js                           (Modo interactivo)
 */

const readline = require('readline');
const {
    loadIgnoredMerchants,
    addIgnoredMerchant,
    removeIgnoredMerchant,
    IGNORED_MERCHANTS_BINANCE_FILE
} = require('./binance/eligibility');

const args = process.argv.slice(2);

function printList() {
    const list = loadIgnoredMerchants();
    console.log('\n========================================================================');
    console.log(` 🚫 LISTA DE ANUNCIANTES BLOQUEADOS / IGNORADOS EN BINANCE (${list.length})`);
    console.log('========================================================================');
    console.log(`📁 Archivo: ${IGNORED_MERCHANTS_BINANCE_FILE}\n`);

    if (list.length === 0) {
        console.log('   (Actualmente no hay ningún comerciante bloqueado en Binance)');
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
            console.error('❌ Debes especificar el nombre a remover. Ej: node bloquear_binance.js --remove "Nombre"');
            return;
        }
        removeIgnoredMerchant(toRemove);
        console.log(`\n🔓 Comerciante "${toRemove}" desbloqueado y eliminado de la lista de Binance.`);
        printList();
        return;
    }

    // Argumentos directos pasados en CLI
    const namesToAdd = args.filter(a => !a.startsWith('-')).join(' ');
    if (namesToAdd.trim()) {
        const names = namesToAdd.split(',').map(n => n.trim()).filter(Boolean);
        names.forEach(name => {
            addIgnoredMerchant(name);
            console.log(`🚫 Comerciante "${name}" bloqueado exitosamente en Binance.`);
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

    console.log('Instrucciones (Binance P2P):');
    console.log(' • Escribe el NOMBRE del anunciante de Binance que deseas bloquear.');
    console.log(' • Para bloquear varios a la vez, sepáralos con comas (ej: User1, User2).');
    console.log(' • Para desbloquear a alguien, antepón un guion (ej: -NombreUser).');
    console.log(' • Presiona ENTER vacío para salir.\n');

    rl.question('✏️  Nombre a bloquear/desbloquear en Binance: ', (answer) => {
        rl.close();
        const input = (answer || '').trim();
        if (!input) {
            console.log('Operación cancelada.');
            return;
        }

        if (input.startsWith('-')) {
            const toRemove = input.slice(1).trim();
            removeIgnoredMerchant(toRemove);
            console.log(`\n🔓 Comerciante "${toRemove}" desbloqueado en Binance.`);
        } else {
            const names = input.split(',').map(n => n.trim()).filter(Boolean);
            names.forEach(name => {
                addIgnoredMerchant(name);
                console.log(`\n🚫 Comerciante "${name}" bloqueado en Binance.`);
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
