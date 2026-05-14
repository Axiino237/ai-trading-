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
            // 1. Mandatory Pre-Flight Check: Deduct from Paper Funds if mode is PAPER
            // We MUST do this BEFORE inserting into the DB to prevent ghost trades when wallet is empty.
            if (tradeData.trading_type === 'PAPER') {
                const totalCost = (tradeData.entry_price || 0) * (tradeData.quantity || 1);
                const currentBalance = await this.getPaperFunds(tradeData.user_id);
                
                if (currentBalance < totalCost) {
                    throw new Error(`Insufficient Paper Funds! Need ₹${totalCost.toFixed(2)}, Have ₹${currentBalance.toFixed(2)}`);
                }
            }

            // 2. Insert the trade into the database
            const { data, error } = await supabase
                .from('trades')
                .insert([{
                    user_id: tradeData.user_id,
                    symbol: tradeData.symbol,
                    type: tradeData.type, // 'BUY' or 'SELL'
                    side: `${tradeData.type === 'BUY' ? 'LONG' : 'SHORT'}_${tradeData.trading_type || 'PAPER'}`,
                    entry_price: tradeData.entry_price,
                    stop_loss: tradeData.stop_loss,
                    take_profit: tradeData.take_profit,
                    quantity: tradeData.quantity || 1,
                    trade_mode: tradeData.trade_mode || 'BOT', // 'BOT' or 'MANUAL'
                    holding_type: tradeData.holding_type || 'SHORT_TERM',
                    expected_duration: tradeData.expected_duration || null,
                    status: 'OPEN',
                    created_at: new Date().toISOString()
                }]);

            if (error) throw error;

            // 3. Actually deduct the funds now that DB insert is successful
            if (tradeData.trading_type === 'PAPER') {
                const totalCost = (tradeData.entry_price || 0) * (tradeData.quantity || 1);
                await this.deductPaperFunds(tradeData.user_id, totalCost);
            }

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
     * Add symbol to user's watchlist
     */
    async addToWatchlist(userId, symbol) {
        try {
            const { data: existing } = await supabase
                .from('watchlist')
                .select('id')
                .eq('user_id', userId)
                .eq('symbol', symbol)
                .single();
            
            if (existing) return { success: true };

            const { error } = await supabase
                .from('watchlist')
                .insert([{ 
                    user_id: userId, 
                    symbol: symbol,
                    asset_type: 'EQUITY',
                    created_at: new Date().toISOString()
                }]);
            
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error('Add to watchlist error:', error.message);
            throw error;
        }
    }

    /**
     * Remove symbol from user's watchlist
     */
    async removeFromWatchlist(userId, symbol) {
        try {
            const { error } = await supabase
                .from('watchlist')
                .delete()
                .eq('user_id', userId)
                .eq('symbol', symbol);
            
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error('Remove from watchlist error:', error.message);
            throw error;
        }
    }
    /**
     * Get paper trading balance for a user
     */
    async getPaperFunds(userId) {
        try {
            const { data } = await supabase
                .from('paper_funds')
                .select('balance')
                .eq('user_id', userId)
                .single();
            return data ? data.balance : 100000;
        } catch (e) { return 100000; }
    }

    async deductPaperFunds(userId, amount) {
        try {
            const current = await this.getPaperFunds(userId);
            const newBalance = current - amount;
            await supabase
                .from('paper_funds')
                .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' });
            return newBalance;
        } catch (e) {
            console.error('Wallet deduction failed:', e.message);
        }
    }

    async creditPaperFunds(userId, amount) {
        try {
            const current = await this.getPaperFunds(userId);
            const newBalance = current + amount;
            await supabase
                .from('paper_funds')
                .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' });
            return newBalance;
        } catch (e) {
            console.error('Wallet credit failed:', e.message);
        }
    }

    /**
     * Get user settings (Mapped to UI expectations)
     */
    async getUserSettings(userId) {
        try {
            const { data } = await supabase
                .from('auto_settings')
                .select('*')
                .eq('user_id', userId)
                .single();

            console.log(`[DEBUG] DB Data:`, data ? 'Found' : 'Missing');
            
            const finalSettings = {
                user_id: data ? data.user_id : userId,
                daily_trade_limit: data ? (data.max_trades_per_day || 5) : 5,
                auto_trade_on: data ? (data.is_auto_active || false) : false,
                trade_mode: data ? (data.trade_mode || 'PAPER') : 'PAPER',
                scan_mode: data ? (data.scan_mode || 'STRICT') : 'STRICT',
                risk_per_trade: data ? (data.risk_per_trade || 1) : 1,
                // NEW RISK PARAMS
                max_utilization_pct: data ? (data.max_utilization_pct || 60) : 60,
                min_allocation_pct: data ? (data.min_allocation_pct || 10) : 10,
                max_allocation_pct: data ? (data.max_allocation_pct || 20) : 20,
                short_term_ratio: data ? (data.short_term_ratio || 70) : 70,
                ai_confidence_threshold: data ? (data.ai_confidence_threshold || 70) : 70
            };
            console.log(`[SETTINGS] Loaded:`, JSON.stringify(finalSettings));
            return finalSettings;
        } catch (error) {
            return { 
                user_id: userId, daily_trade_limit: 5, auto_trade_on: false, trade_mode: 'PAPER', scan_mode: 'STRICT',
                max_utilization_pct: 60, min_allocation_pct: 10, max_allocation_pct: 20, short_term_ratio: 70, ai_confidence_threshold: 70
            };
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
            console.log(`[SETTINGS UPDATE] Incoming for ${userId}:`, JSON.stringify(updates));
            
            // 1. Fetch current settings to avoid overwriting with undefined
            const { data: current } = await supabase
                .from('auto_settings')
                .select('*')
                .eq('user_id', userId)
                .single();

            // 2. Map UI fields back to DB columns
            const autoActive = updates.auto_trade_on !== undefined ? updates.auto_trade_on : updates.is_auto_active;
            const dailyLimit = updates.daily_trade_limit !== undefined ? updates.daily_trade_limit : updates.max_trades_per_day;
            const tradeMode = updates.trade_mode || (current ? current.trade_mode : 'PAPER');

            const dbSettings = {
                user_id: userId,
                is_auto_active: autoActive !== undefined ? autoActive : (current ? current.is_auto_active : false),
                max_trades_per_day: dailyLimit !== undefined ? parseInt(dailyLimit) : (current ? current.max_trades_per_day : 5),
                scan_mode: updates.scan_mode || (current ? current.scan_mode : 'STRICT'),
                risk_per_trade: updates.risk_per_trade !== undefined ? updates.risk_per_trade : (current ? current.risk_per_trade : 1),
                trade_mode: tradeMode,
                // NEW RISK PARAMS
                max_utilization_pct: updates.max_utilization_pct !== undefined ? updates.max_utilization_pct : (current ? current.max_utilization_pct : 60),
                min_allocation_pct: updates.min_allocation_pct !== undefined ? updates.min_allocation_pct : (current ? current.min_allocation_pct : 10),
                max_allocation_pct: updates.max_allocation_pct !== undefined ? updates.max_allocation_pct : (current ? current.max_allocation_pct : 20),
                short_term_ratio: updates.short_term_ratio !== undefined ? updates.short_term_ratio : (current ? current.short_term_ratio : 70),
                ai_confidence_threshold: updates.ai_confidence_threshold !== undefined ? updates.ai_confidence_threshold : (current ? current.ai_confidence_threshold : 70)
            };

            console.log(`[SETTINGS] Upserting to DB:`, JSON.stringify(dbSettings));

            const { error } = await supabase
                .from('auto_settings')
                .upsert(dbSettings, { onConflict: 'user_id' });
            
            if (error) {
                // If it fails because column doesn't exist, we might need to inform user
                if (error.message.includes('column "trade_mode" does not exist')) {
                    console.error('[SETTINGS] ERROR: trade_mode column is MISSING in Supabase table "auto_settings"');
                    throw new Error('Database column "trade_mode" missing. Please add it via SQL: ALTER TABLE auto_settings ADD COLUMN trade_mode TEXT DEFAULT \'PAPER\';');
                }
                throw error;
            }

            console.log(`[SETTINGS] DB Sync Successful for ${userId} ✅`);
            return { success: true };
        } catch (error) {
            console.error('[SETTINGS] Update Error:', error.message);
            throw error;
        }
    }
    /**
     * Save System Activity Log
     */
    async saveLog(level, symbol, message, data) {
        try {
            await supabase.from('system_logs').insert([{
                level, symbol, message, data,
                created_at: new Date().toISOString()
            }]);
        } catch (e) {}
    }

    /**
     * Get Logs with Pagination (Lazy Loading)
     */
    async getLogs(limit = 20, offset = 0) {
        try {
            const { data, error } = await supabase
                .from('system_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Fetch Logs Error:', error.message);
            return [];
        }
    }

    /**
     * Delete logs older than 5 days to save storage
     */
    async cleanupOldLogs() {
        try {
            const fiveDaysAgo = new Date();
            fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
            
            const { error, count } = await supabase
                .from('system_logs')
                .delete({ count: 'exact' })
                .lt('created_at', fiveDaysAgo.toISOString());

            if (error) throw error;
            if (count > 0) {
                console.log(`[DB MAINTENANCE] Automatically deleted ${count} old system logs (older than 5 days). 🧹`);
            }
        } catch (e) {
            console.error('[DB MAINTENANCE ERROR] Failed to clean up old logs:', e.message);
        }
    }

    /**
     * Get Total Invested Capital for open positions
     */
    async getInvestedCapital(userId, tradingMode) {
        try {
            const { data, error } = await supabase
                .from('trades')
                .select('entry_price, quantity')
                .eq('user_id', userId)
                .eq('status', 'OPEN')
                .ilike('side', `%_${tradingMode}`);

            if (error) throw error;
            
            const total = data.reduce((acc, trade) => {
                return acc + (trade.entry_price * (trade.quantity || 1));
            }, 0);
            
            return total;
        } catch (error) {
            console.error('[SUPABASE] Invested Capital Error:', error.message);
            return 0;
        }
    }

    /**
     * Get counts for trade types to maintain ratio
     */
    async getTradeTypeCounts(userId) {
        try {
            const { data, error } = await supabase
                .from('trades')
                .select('holding_type')
                .eq('user_id', userId)
                .eq('status', 'OPEN');

            if (error) throw error;

            const counts = { SHORT_TERM: 0, LONG_TERM: 0 };
            data.forEach(t => {
                if (t.holding_type === 'LONG_TERM') counts.LONG_TERM++;
                else counts.SHORT_TERM++;
            });
            return counts;
        } catch (error) {
            return { SHORT_TERM: 0, LONG_TERM: 0 };
        }
    }
}

module.exports = new SupabaseService();
