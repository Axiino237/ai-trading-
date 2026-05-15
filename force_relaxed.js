const svc = require('./supabaseService');

async function updateLimit() {
    try {
        const userId = '9bc2e5af-f5f4-4435-95a0-5672bd290b31';
        // Passing ONLY valid columns or letting updateSettings handle mapping
        await svc.updateSettings(userId, { 
            scan_mode: 'RELAXED',
            max_trades_per_day: 100 
        });
        console.log('User daily limit updated to 100 ✅');
    } catch (e) {
        console.error(e);
    }
}

updateLimit();
