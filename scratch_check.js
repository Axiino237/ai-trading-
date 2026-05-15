const svc = require('./supabaseService');

async function check() {
    try {
        const logs = await svc.getLogs(10);
        console.log('--- LATEST LOGS ---');
        logs.forEach(l => {
            console.log(`[${l.created_at}] [${l.level}] [${l.symbol}] ${l.message}`);
            if (l.data) console.log('   Data:', JSON.stringify(l.data));
        });
        
        const { data: settings } = await svc.supabase.from('auto_settings').select('*');
        console.log('--- AUTO SETTINGS ---');
        console.log(JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error(e);
    }
}

check();
