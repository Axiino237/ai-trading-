const svc = require('./supabaseService');

async function check() {
    try {
        const { data: logs } = await svc.supabase
            .from('system_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10);
        
        console.log('--- LATEST LOGS IN DB ---');
        logs.forEach(l => {
            console.log(`[${l.created_at}] [${l.level}] [${l.symbol}] ${l.message}`);
        });
    } catch (e) {
        console.error(e);
    }
}

check();
