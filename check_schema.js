const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkSchema() {
    console.log('Checking Supabase Schema...');
    
    // Try to get one row from auto_settings to see keys
    const { data, error } = await supabase.from('auto_settings').select('*').limit(1);
    if (error) {
        console.error('Error fetching auto_settings:', error.message);
    } else {
        console.log('auto_settings columns:', Object.keys(data[0] || {}));
    }

    const { data: trades, error: tradesErr } = await supabase.from('trades').select('*').limit(1);
    if (tradesErr) {
        console.error('Error fetching trades:', tradesErr.message);
    } else {
        console.log('trades columns:', Object.keys(trades[0] || {}));
    }
}

checkSchema();
