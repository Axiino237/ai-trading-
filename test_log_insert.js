const svc = require('./supabaseService');

async function testInsert() {
    try {
        console.log('Attempting manual log insert...');
        const payload = {
            level: 'info',
            symbol: 'TEST-SYM',
            message: 'Manual test log at ' + new Date().toISOString(),
            data: { test: true },
            created_at: new Date().toISOString()
        };
        
        const { data, error } = await svc.supabase
            .from('system_logs')
            .insert([payload])
            .select();
        
        if (error) {
            console.error('INSERT ERROR:', error);
        } else {
            console.log('INSERT SUCCESS:', data);
        }
    } catch (e) {
        console.error('CRITICAL ERROR:', e);
    }
}

testInsert();
