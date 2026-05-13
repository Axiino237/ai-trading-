/**
 * fix_db.js — Creates paper_funds table + aligns user IDs + enables auto-trading
 * Run once: node fix_db.js
 */
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// The real user_id from auto_settings DB
const REAL_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

async function fixDB() {
    console.log('\n🔧 StocksPro DB Fix Script Starting...\n');

    // ────────────────────────────────────────────────
    // 1. Check & create paper_funds row for REAL user
    // ────────────────────────────────────────────────
    console.log('[1/4] Checking paper_funds for real user...');
    const { data: fundData, error: fundErr } = await supabase
        .from('paper_funds')
        .select('*')
        .eq('user_id', REAL_USER_ID);

    if (fundErr) {
        console.log(`  ⚠️  paper_funds table missing or inaccessible: ${fundErr.message}`);
        console.log('  ℹ️  You need to run this SQL in Supabase Dashboard > SQL Editor:');
        console.log(`
  ┌─────────────────────────────────────────────────────────────────┐
  │  CREATE TABLE IF NOT EXISTS paper_funds (                        │
  │      user_id TEXT PRIMARY KEY,                                   │
  │      balance DECIMAL DEFAULT 100000.00                          │
  │  );                                                              │
  │                                                                  │
  │  INSERT INTO paper_funds (user_id, balance)                      │
  │  VALUES ('550e8400-e29b-41d4-a716-446655440000', 100000.00)     │
  │  ON CONFLICT (user_id) DO NOTHING;                               │
  │                                                                  │
  │  INSERT INTO paper_funds (user_id, balance)                      │
  │  VALUES ('00000000-0000-0000-0000-000000000000', 100000.00)     │
  │  ON CONFLICT (user_id) DO NOTHING;                               │
  └─────────────────────────────────────────────────────────────────┘
        `);
    } else {
        console.log(`  ✅ paper_funds OK. Rows: ${fundData.length}`);
    }

    // ────────────────────────────────────────────────
    // 2. Enable auto_trade for the real user
    // ────────────────────────────────────────────────
    console.log('\n[2/4] Enabling auto-trade for real user...');
    const { error: enableErr } = await supabase
        .from('auto_settings')
        .update({ is_auto_active: true })
        .eq('user_id', REAL_USER_ID);

    if (enableErr) {
        console.log(`  ❌ Failed: ${enableErr.message}`);
    } else {
        console.log(`  ✅ is_auto_active = true for ${REAL_USER_ID}`);
    }

    // ────────────────────────────────────────────────
    // 3. Ensure MOCK user also has auto_settings row
    // ────────────────────────────────────────────────
    console.log('\n[3/4] Ensuring MOCK user (00000000...) has auto_settings...');
    const MOCK_USER_ID = '00000000-0000-0000-0000-000000000000';
    const { error: upsertErr } = await supabase
        .from('auto_settings')
        .upsert({
            user_id: MOCK_USER_ID,
            is_auto_active: true,
            max_trades_per_day: 5,
            scan_mode: 'RELAXED',
            risk_per_trade: 1,
            max_daily_loss_pct: 5,
            interval_minutes: 5
        }, { onConflict: 'user_id' });

    if (upsertErr) {
        console.log(`  ❌ MOCK user upsert failed: ${upsertErr.message}`);
    } else {
        console.log(`  ✅ MOCK user auto_settings upserted with is_auto_active = true`);
    }

    // ────────────────────────────────────────────────
    // 4. Verify final state
    // ────────────────────────────────────────────────
    console.log('\n[4/4] Final verification...');
    const { data: users, error: verifyErr } = await supabase
        .from('auto_settings')
        .select('user_id, is_auto_active, scan_mode, max_trades_per_day')
        .eq('is_auto_active', true);

    if (verifyErr) {
        console.log(`  ❌ Verify failed: ${verifyErr.message}`);
    } else {
        console.log(`  ✅ Auto-enabled users (${users.length}):`);
        users.forEach(u => {
            console.log(`     → ${u.user_id} | scan: ${u.scan_mode} | max: ${u.max_trades_per_day} trades/day`);
        });
    }

    console.log('\n✅ Fix complete! Restart the backend now: node index.js\n');
}

fixDB().catch(console.error);
