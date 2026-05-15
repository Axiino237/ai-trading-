const svc = require('./supabaseService');

async function setStrict() {
    try {
        const userId = '9bc2e5af-f5f4-4435-95a0-5672bd290b31';
        await svc.updateSettings(userId, { 
            scan_mode: 'STRICT',
            max_trades_per_day: 5 
        });
        console.log('User settings restored to STRICT mode (Limit: 5) ✅');
    } catch (e) {
        console.error(e);
    }
}

setStrict();
