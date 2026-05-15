const svc = require('./supabaseService');

async function checkTrades() {
    try {
        const { data, error } = await svc.supabase
            .from('trades')
            .select('*')
            .limit(1);
        
        if (error) throw error;
        if (data && data.length > 0) {
            console.log('Columns in trades:', Object.keys(data[0]));
        } else {
            console.log('No data in trades.');
        }
    } catch (e) {
        console.error(e);
    }
}

checkTrades();
