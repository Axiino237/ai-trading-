const svc = require('./supabaseService');

async function checkCols() {
    try {
        const { data } = await svc.supabase.from('auto_settings').select('*').limit(1);
        if (data && data.length > 0) console.log('Columns:', Object.keys(data[0]));
    } catch (e) { console.error(e); }
}

checkCols();
