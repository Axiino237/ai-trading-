const svc = require('./supabaseService');

async function audit() {
    try {
        const userId = '9bc2e5af-f5f4-4435-95a0-5672bd290b31'; // Using the user ID from previous logs
        
        // 1. Get all trades
        const { data: trades } = await svc.supabase
            .from('trades')
            .select('*')
            .eq('user_id', userId);
        
        // 2. Get all wallet logs
        const { data: logs } = await svc.supabase
            .from('wallet_logs')
            .select('*')
            .eq('user_id', userId);
        
        // 3. Current Paper Balance
        const balance = await svc.getPaperFunds(userId);
        
        console.log(`--- AUDIT REPORT FOR USER ${userId} ---`);
        console.log(`Current Paper Balance: ₹${balance.toFixed(2)}`);
        console.log(`\n--- TRADES (${trades.length}) ---`);
        
        let totalEntryCost = 0;
        let totalExitCredit = 0;
        
        trades.forEach(t => {
            const cost = t.entry_price * (t.quantity || 1);
            if (t.status === 'OPEN' || t.status === 'CLOSED') {
                totalEntryCost += cost;
            }
            
            if (t.status === 'CLOSED') {
                const isBuy = t.type === 'BUY';
                const pnl = isBuy ? (t.exit_price - t.entry_price) * (t.quantity || 1) : (t.entry_price - t.exit_price) * (t.quantity || 1);
                totalExitCredit += (cost + pnl);
                console.log(`[CLOSED] ${t.symbol} | Qty: ${t.quantity} | Entry: ${t.entry_price} | Exit: ${t.exit_price} | P&L: ₹${pnl.toFixed(2)}`);
            } else if (t.status === 'OPEN') {
                console.log(`[OPEN]   ${t.symbol} | Qty: ${t.quantity} | Entry: ${t.entry_price} | Cost: ₹${cost.toFixed(2)}`);
            }
        });
        
        console.log(`\n--- WALLET LOGS (${logs.length}) ---`);
        let actualDeducted = 0;
        let actualCredited = 0;
        
        logs.forEach(l => {
            if (l.type === 'TRADE_OPEN') actualDeducted += Math.abs(l.amount);
            if (l.type === 'TRADE_EXIT') actualCredited += Math.abs(l.amount);
        });
        
        console.log(`Total Entry Cost of all trades: ₹${totalEntryCost.toFixed(2)}`);
        console.log(`Total Deducted from Wallet:    ₹${actualDeducted.toFixed(2)}`);
        console.log(`Total Exit Credit (Calculated): ₹${totalExitCredit.toFixed(2)}`);
        console.log(`Total Credited to Wallet:      ₹${actualCredited.toFixed(2)}`);
        
        if (totalEntryCost > actualDeducted) {
            console.log(`\n[ALERT] Wallet is MISSING deductions of ₹${(totalEntryCost - actualDeducted).toFixed(2)}!`);
        } else {
            console.log(`\n[OK] Wallet deductions match trades.`);
        }

    } catch (e) {
        console.error(e);
    }
}

audit();
