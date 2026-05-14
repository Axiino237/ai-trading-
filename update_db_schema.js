const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function updateSchema() {
    console.log('Updating Database Schema for Risk Management...');

    const sqlCommands = [
        // Update trades table
        `ALTER TABLE trades ADD COLUMN IF NOT EXISTS holding_type TEXT DEFAULT 'SHORT_TERM';`,
        `ALTER TABLE trades ADD COLUMN IF NOT EXISTS expected_duration TEXT;`,
        
        // Update auto_settings table
        `ALTER TABLE auto_settings ADD COLUMN IF NOT EXISTS max_utilization_pct INTEGER DEFAULT 60;`,
        `ALTER TABLE auto_settings ADD COLUMN IF NOT EXISTS min_allocation_pct INTEGER DEFAULT 10;`,
        `ALTER TABLE auto_settings ADD COLUMN IF NOT EXISTS max_allocation_pct INTEGER DEFAULT 20;`,
        `ALTER TABLE auto_settings ADD COLUMN IF NOT EXISTS short_term_ratio INTEGER DEFAULT 70;`,
        `ALTER TABLE auto_settings ADD COLUMN IF NOT EXISTS ai_confidence_threshold INTEGER DEFAULT 70;`
    ];

    for (const sql of sqlCommands) {
        try {
            console.log(`Executing: ${sql}`);
            const { error } = await supabase.rpc('execute_sql', { sql: sql });
            if (error) {
                console.error(`Error: ${error.message}`);
                console.log('Trying direct query fallback...');
                // Fallback: If RPC is not available, we can't easily run raw SQL from client.
                // In production Supabase, you usually use the SQL Editor.
            }
        } catch (e) {
            console.error(`Fatal: ${e.message}`);
        }
    }
    
    console.log('Schema update attempt finished.');
}

updateSchema();
