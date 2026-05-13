const fs = require('fs');
const path = require('path');
const supabaseService = require('./supabaseService');

class Logger {
    constructor() {
        this.logFile = path.join(__dirname, 'activity.log');
    }

    async log(level, symbol, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${symbol ? `[${symbol}] ` : ''}${message}\n`;
        
        // 1. Mirror to local file (VITAL PROOF)
        fs.appendFileSync(this.logFile, logEntry);

        // 2. Log to console
        const color = level === 'success' ? '\x1b[32m' : level === 'error' ? '\x1b[31m' : '\x1b[33m';
        console.log(`${color}${logEntry}\x1b[0m`);

        // 3. Persist to DB (for Dashboard)
        try {
            await supabaseService.saveLog(level, symbol, message, data);
        } catch (e) {
            // Silently fail if DB table missing, local file still has the proof
        }
    }

    info(msg, data) { this.log('info', data?.symbol, msg, data); }
    warn(msg, data) { this.log('warn', data?.symbol, msg, data); }
    error(msg, data) { this.log('error', data?.symbol, msg, data); }
    success(msg, data) { this.log('success', data?.symbol, msg, data); }
}

module.exports = new Logger();
