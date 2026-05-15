const fs = require('fs');
const path = require('path');
const supabaseService = require('./supabaseService');

class Logger {
    constructor() {
        this.logFile = path.join(__dirname, 'activity.log');
    }

    async log(level, symbol, message, data = null, userId = null) {
        const timestamp = new Date().toISOString();
        
        // Simple symbol extraction if not provided
        if (!symbol && message.includes('[SCANNER]')) {
            const parts = message.split(' ');
            symbol = parts[1]; // Should be the symbol
        }

        const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${symbol ? `[${symbol}] ` : ''}${message}\n`;
        
        fs.appendFileSync(this.logFile, logEntry);
        console.log(`${level === 'success' ? '\x1b[32m' : level === 'error' ? '\x1b[31m' : '\x1b[33m'}${logEntry}\x1b[0m`);

        try {
            // FORCE SAVE TO DB
            await supabaseService.saveLog(level, symbol || 'SYSTEM', message, data, userId);
        } catch (e) {
            console.error('DB LOG SAVE FAILED:', e.message);
        }
    }

    info(msg, data) { this.log('info', data?.symbol, msg, data, data?.userId || data?.user_id); }
    warn(msg, data) { this.log('warn', data?.symbol, msg, data, data?.userId || data?.user_id); }
    error(msg, data) { this.log('error', data?.symbol, msg, data, data?.userId || data?.user_id); }
    success(msg, data) { this.log('success', data?.symbol, msg, data, data?.userId || data?.user_id); }
}

module.exports = new Logger();
