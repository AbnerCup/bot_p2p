/**
 * Herramienta de Reportes y Análisis del Mercado P2P
 * Analiza el historial acumulado en market_history.csv y market_history.json
 */

const { analyzeMarketHistory } = require('./binance/market_logger');

analyzeMarketHistory();
