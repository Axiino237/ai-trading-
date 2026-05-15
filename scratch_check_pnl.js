const supabaseService = require('./supabaseService');
const angelOneService = require('./angelOneService');

async function checkPnL() {
    const userId = '9bc2e5af-f5f4-4435-95a0-5672bd290b31'; // User with OPEN trades
    const mode = 'PAPER';

    console.log('--- CHECKING LIVE PNL ---');
    try {
        await angelOneService.login();
        
        const pnl = await supabaseService.getLivePnL(userId, mode, angelOneService);
        console.log(`Final Calculated Live PnL: ₹${pnl}`);

        // Debug: Check open trades manually
        const { data: openTrades } = await supabaseService.supabase
            .from('trades')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'OPEN')
            .eq('side', mode);
        
        console.log(`Open Trades Found: ${openTrades?.length || 0}`);
        if (openTrades) {
            openTrades.forEach(t => {
                console.log(`- ${t.symbol}: Entry ₹${t.entry_price}, Qty ${t.quantity}`);
            });
        }

    } catch (e) {
        console.error('Check failed:', e.message);
    }
}

checkPnL();
