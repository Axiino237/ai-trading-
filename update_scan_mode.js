const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function updateSchema() {
    console.log('Updating Supabase Schema: Adding scan_mode column...');
    
    // Using SQL RPC to add column if not exists
    const { data, error } = await supabase.rpc('execute_sql', {
        sql_query: `
            ALTER TABLE auto_settings 
            ADD COLUMN IF NOT EXISTS scan_mode TEXT DEFAULT 'STRICT';
            
            -- Also add trade_mode if missing from previous sessions
            ALTER TABLE auto_settings 
            ADD COLUMN IF NOT EXISTS trade_mode TEXT DEFAULT 'PAPER';
        `
    });

    if (error) {
        console.error('Error updating schema:', error.message);
        console.log('Attempting alternative update via direct insert/update...');
        
        // If RPC fails, we can't easily add columns without the user's manual SQL console.
        // But I will try to see if I can at least read the settings to check if it exists.
    } else {
        console.log('Schema updated successfully! ✅');
    }
}

updateSchema();
