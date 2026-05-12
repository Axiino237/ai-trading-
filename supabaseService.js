const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

class SupabaseService {
    constructor() {
        this.supabase = supabase;
    }
    /**
     * Save a generated signal/trade to DB
     */
    async saveTrade(tradeData) {
        try {
            const { data, error } = await supabase
                .from('trades')
                .insert([{
                    user_id: tradeData.user_id || '00000000-0000-0000-0000-000000000000',
                    symbol: tradeData.symbol,
                    type: tradeData.type, // 'BUY' or 'SELL'
                    side: `${tradeData.type === 'BUY' ? 'LONG' : 'SHORT'}_${tradeData.trading_type || 'PAPER'}`,
                    entry_price: tradeData.entry_price,
                    stop_loss: tradeData.stop_loss,
                    take_profit: tradeData.take_profit,
                    trade_mode: tradeData.trade_mode || 'BOT', // 'BOT' or 'MANUAL'
                    status: 'OPEN',
                    created_at: new Date().toISOString()
                }]);

            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Supabase Save Error:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get trade history
     */
    async getHistory(tradingType = 'PAPER') {
        try {
            const { data, error } = await supabase
                .from('trades')
                .select('*')
                .ilike('side', `%_${tradingType}`)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Supabase Fetch Error:', error.message);
            return [];
        }
    }

    /**
     * Get all users who have auto-trading enabled
     */
    async getAutoEnabledUsers() {
        try {
            const { data, error } = await supabase
                .from('auto_settings')
                .select('user_id')
                .eq('is_auto_active', true);

            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('Supabase Fetch Enabled Users Error:', error.message);
            return [];
        }
    }

    /**
     * Get watchlist for a specific user
     */
    async getUserWatchlist(userId) {
        try {
            const { data, error } = await supabase
                .from('watchlist')
                .select('*')
                .eq('user_id', userId);

            if (error) {
                console.log('[SUPABASE] Watchlist fetch error, using fallback');
                return [{ symbol: 'RELIANCE' }, { symbol: 'TATASTEEL' }, { symbol: 'SBIN' }];
            }
            return data || [];
        } catch (error) {
            return [{ symbol: 'RELIANCE' }, { symbol: 'TATASTEEL' }, { symbol: 'SBIN' }];
        }
    }
    /**
     * Get paper trading balance for a user
     */
    async getPaperFunds(userId) {
        try {
            const { data, error } = await supabase
                .from('paper_funds')
                .select('balance')
                .eq('user_id', userId)
                .single();

            if (error) return 100000.00;
            return data.balance;
        } catch (error) {
            return 100000.00;
        }
    }
    /**
     * Get user settings (Mapped to UI expectations)
     */
    async getUserSettings(userId) {
        try {
            const { data, error } = await supabase
                .from('auto_settings')
                .select('*')
                .eq('user_id', userId)
                .single();
            
            let localMode = 'PAPER';
            try {
                const fs = require('fs');
                if (fs.existsSync('./local_settings.json')) {
                    const local = JSON.parse(fs.readFileSync('./local_settings.json', 'utf8'));
                    localMode = local[userId]?.trade_mode || 'PAPER';
                }
            } catch (e) {}

            if (error || !data) {
                return { user_id: userId, daily_trade_limit: 5, auto_trade_on: false, trade_mode: localMode };
            }

            // Map DB columns to UI fields
            return {
                user_id: data.user_id,
                daily_trade_limit: data.max_trades_per_day || 5,
                auto_trade_on: data.is_auto_active || false,
                trade_mode: localMode
            };
        } catch (error) {
            return { user_id: userId, daily_trade_limit: 5, auto_trade_on: false, trade_mode: 'PAPER' };
        }
    }

    /**
     * Get number of trades taken today
     */
    async getTodayTradeCount(userId) {
        try {
            const today = new Date().toISOString().split('T')[0];
            const { count, error } = await supabase
                .from('trades')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('created_at', today);
            return count || 0;
        } catch (error) {
            return 0;
        }
    }

    async updateSettings(userId, updates) {
        try {
            // Save trade_mode to local file as fallback
            if (updates.trade_mode) {
                try {
                    const fs = require('fs');
                    let local = {};
                    if (fs.existsSync('./local_settings.json')) {
                        local = JSON.parse(fs.readFileSync('./local_settings.json', 'utf8'));
                    }
                    local[userId] = { ...local[userId], trade_mode: updates.trade_mode };
                    fs.writeFileSync('./local_settings.json', JSON.stringify(local, null, 2));
                } catch (e) {}
            }

            // 1. Fetch current settings to avoid overwriting with undefined
            const { data: current } = await supabase
                .from('auto_settings')
                .select('*')
                .eq('user_id', userId)
                .single();

            // 2. Merge incoming updates with existing values
            // Note: trade_mode is omitted because the column does not exist in the database schema.
            const dbSettings = {
                user_id: userId,
                is_auto_active: updates.auto_trade_on !== undefined ? updates.auto_trade_on : (current ? current.is_auto_active : false),
                max_trades_per_day: updates.daily_trade_limit !== undefined ? updates.daily_trade_limit : (current ? current.max_trades_per_day : 5)
            };

            const { error } = await supabase
                .from('auto_settings')
                .upsert(dbSettings, { onConflict: 'user_id' });
            
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error('Update Settings Error:', error.message);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new SupabaseService();
