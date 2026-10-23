const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env');

function loadEnv() {
    if (!fs.existsSync(ENV_FILE)) {
        return {};
    }

    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const config = {};

    content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key) {
                config[key.trim()] = valueParts.join('=').trim();
            }
        }
    });

    return config;
}

module.exports = { loadEnv, ENV_FILE };
