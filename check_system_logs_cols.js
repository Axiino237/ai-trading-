const svc = require('./supabaseService');

async function checkColumns() {
    try {
        const { data, error } = await svc.supabase
            .from('system_logs')
            .select('*')
            .limit(1);
        
        if (error) throw error;
        if (data && data.length > 0) {
            console.log('Columns in system_logs:', Object.keys(data[0]));
        } else {
            console.log('No data in system_logs to check columns.');
        }
    } catch (e) {
        console.error(e);
    }
}

checkColumns();
