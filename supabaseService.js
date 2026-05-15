const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

class SupabaseService {
    constructor() {
        this.supabase = supabase;
    }

    async getUserByEmail(email) {
        const { data, error } = await supabase
            .from('app_users')
            .select('*')
            .ilike('email', email)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null;
            throw error;
        }
        return data;
    }

    async getUserById(id) {
        const { data, error } = await supabase
            .from('app_users')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null;
            throw error;
        }
        return data;
    }

    async createUser(user) {
        const { data, error } = await supabase
            .from('app_users')
            .insert([user])
            .select('id, name, email, role, created_at')
            .single();

        if (error) {
            if (error.message && error.message.includes('relation "app_users" does not exist')) {
                throw new Error('app_users table is missing. Run the auth migration SQL first.');
            }
            throw error;
        }
        return data;
    }

    async createSession(session) {
        const { data, error } = await supabase
            .from('app_sessions')
            .insert([session])
            .select('*')
            .single();

        if (error) {
            if (error.message && error.message.includes('relation "app_sessions" does not exist')) {
                throw new Error('app_sessions table is missing. Run the auth migration SQL first.');
            }
            throw error;
        }
        return data;
    }

    async getSession(tokenHash) {
        const { data, error } = await supabase
            .from('app_sessions')
            .select('*')
            .eq('token_hash', tokenHash)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null;
            throw error;
        }
        return data;
    }

    async deleteSession(tokenHash) {
        const { error } = await supabase
            .from('app_sessions')
            .delete()
            .eq('token_hash', tokenHash);

        if (error) throw error;
        return true;
    }
    /**
     * Save a generated signal/trade to DB
     */
    async saveTrade(tradeData) {
        try {
            const isPaper = tradeData.trading_type === 'PAPER' || tradeData.side === 'PAPER' || tradeData.tradingMode === 'PAPER';
            const tradeType = tradeData.type || tradeData.side; // 'BUY' or 'SELL'
            
            // 1. Mandatory Pre-Flight Check: Deduct from Paper Funds if mode is PAPER
            if (isPaper) {
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
                    type: tradeType, 
                    side: isPaper ? 'PAPER' : 'REAL', // Simplified for easier monitoring
                    entry_price: tradeData.entry_price,
                    stop_loss: tradeData.stop_loss,
                    take_profit: tradeData.take_profit,
                    quantity: tradeData.quantity || 1,
                    trade_mode: tradeData.trade_mode || 'BOT', 
                    holding_type: tradeData.holding_type || 'SHORT_TERM',
                    expected_duration: tradeData.expected_duration || null,
                    status: 'OPEN',
                    created_at: new Date().toISOString()
                }])
                .select();

            if (error) throw error;
            const newTrade = data?.[0];

            // 3. Actually deduct the funds now that DB insert is successful
            if (isPaper && newTrade) {
                const totalCost = (tradeData.entry_price || 0) * (tradeData.quantity || 1);
                await this.deductPaperFunds(tradeData.user_id, totalCost, 'TRADE_ENTRY', newTrade.id);
            }

            return { success: true, data };
        } catch (error) {
            console.error('Supabase Save Error:', error.message);
            throw error;
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
                .eq('side', tradingType)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Supabase Fetch Error:', error.message);
            return [];
        }
    }

    async getUserTrades(userId) {
        try {
            const { data, error } = await supabase
                .from('trades')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('Supabase User Trades Error:', error.message);
            return [];
        }
    }

    /**
     * Get all users who have auto-trading enabled
     */
    async getAutoEnabledUsers() {
        try {
            // Fetch enabled settings first
            const { data: settings, error: settingsError } = await supabase
                .from('auto_settings')
                .select('*')
                .eq('is_auto_active', true);

            if (settingsError) throw settingsError;
            if (!settings || settings.length === 0) return [];

            // Fetch user plan tiers separately to avoid relationship cache issues
            const userIds = settings.map(s => s.user_id);
            const { data: users, error: usersError } = await supabase
                .from('app_users')
                .select('id, plan_tier')
                .in('id', userIds);

            if (usersError) {
                console.warn('[SUPABASE] Could not fetch user tiers, defaulting to STARTER:', usersError.message);
            }

            const userMap = {};
            (users || []).forEach(u => userMap[u.id] = u.plan_tier);

            return settings.map(s => ({
                ...s,
                plan_tier: userMap[s.user_id] || 'STARTER'
            }));
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
     * Get all unique symbols across ALL users for broadcasting
     */
    async getAllWatchlistSymbols() {
        try {
            const { data, error } = await supabase.from('watchlist').select('symbol');
            if (error) return [];
            return [...new Set(data.map(r => r.symbol))];
        } catch (e) {
            return [];
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
            return data ? parseFloat(data.balance) : 100000;
        } catch (e) { return 100000; }
    }

    async deductPaperFunds(userId, amount, reason = 'UNKNOWN', tradeId = null) {
        try {
            const current = await this.getPaperFunds(userId);
            const amt = parseFloat(amount);
            const newBalance = parseFloat((current - amt).toFixed(2));
            
            // 1. Update Balance
            const { error } = await supabase
                .from('paper_funds')
                .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' });
            
            if (error) throw error;

            // 2. Log Transaction
            await this.logWalletAction(userId, amt, 'DEBIT', reason, newBalance, tradeId);
            
            return newBalance;
        } catch (e) {
            console.error('Wallet deduction failed:', e.message);
            throw e;
        }
    }

    async creditPaperFunds(userId, amount, reason = 'UNKNOWN', tradeId = null) {
        try {
            const current = await this.getPaperFunds(userId);
            const amt = parseFloat(amount);
            const newBalance = parseFloat((current + amt).toFixed(2));
            
            // 1. Update Balance
            const { error } = await supabase
                .from('paper_funds')
                .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' });
            
            if (error) throw error;

            // 2. Log Transaction
            await this.logWalletAction(userId, amt, 'CREDIT', reason, newBalance, tradeId);
            
            return newBalance;
        } catch (e) {
            console.error('Wallet credit failed:', e.message);
            throw e;
        }
    }

    async logWalletAction(userId, amount, type, reason, balanceAfter, tradeId = null) {
        try {
            await supabase.from('wallet_logs').insert([{
                user_id: userId,
                amount,
                type,
                reason,
                balance_after: balanceAfter,
                trade_id: tradeId,
                created_at: new Date().toISOString()
            }]);
        } catch (e) {
            console.error('[AUDIT ERROR] Failed to log wallet action:', e.message);
        }
    }

    async createPaymentRequest(userId, payload) {
        const amount = Number(payload.amount);
        if (!amount || amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }

        const transactionId = String(payload.transaction_id || payload.transactionId || '').trim();
        if (!transactionId) {
            throw new Error('Transaction ID is required');
        }

        const request = {
            id: randomUUID(),
            user_id: userId,
            amount,
            transaction_id: transactionId,
            qr_reference: payload.qr_reference || null,
            note: payload.note || null,
            status: 'PENDING',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('payment_requests')
            .insert([request])
            .select()
            .single();

        if (error) {
            if (error.message && error.message.includes('relation "payment_requests" does not exist')) {
                throw new Error('payment_requests table is missing. Run the payment migration SQL first.');
            }
            throw error;
        }

        return data;
    }

    async getPaymentRequests(options = {}) {
        const limit = options.limit || 50;
        let query = supabase
            .from('payment_requests')
            .select('*, app_users(name)')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (options.userId) {
            query = query.eq('user_id', options.userId);
        }

        if (options.status) {
            query = query.eq('status', options.status);
        }

        const { data, error } = await query;
        if (error) {
            if (error.message && error.message.includes('relation "payment_requests" does not exist')) {
                return [];
            }
            throw error;
        }
        return data || [];
    }

    async getPaymentRequestById(id) {
        const { data, error } = await supabase
            .from('payment_requests')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        return data;
    }

    async updatePaymentRequest(id, updates) {
        const { data, error } = await supabase
            .from('payment_requests')
            .update({
                ...updates,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    async approvePaymentRequest(id, adminMeta = {}) {
        const existing = await this.getPaymentRequestById(id);
        if (!existing) throw new Error('Payment request not found');
        if (existing.status === 'APPROVED') throw new Error('Payment request already approved');
        if (existing.status === 'REJECTED') throw new Error('Rejected payment request cannot be approved');

        // Check if this is a subscription upgrade request
        if (existing.note && existing.note.startsWith('SUBSCRIPTION_UPGRADE:')) {
            const plan = existing.note.split(':')[1];
            const { error: upgradeError } = await supabase
                .from('app_users')
                .update({ plan_tier: plan })
                .eq('id', existing.user_id);
            
            if (upgradeError) throw upgradeError;
            console.log(`[SUBSCRIPTION] User ${existing.user_id} upgraded to ${plan} via approved payment ✅`);
        } else {
            // Standard wallet fund request
            await this.creditPaperFunds(existing.user_id, Number(existing.amount), 'DEPOSIT', existing.id);
        }

        return this.updatePaymentRequest(id, {
            status: 'APPROVED',
            approved_at: new Date().toISOString(),
            approved_by: adminMeta.approvedBy || 'ADMIN',
            admin_note: adminMeta.adminNote || null
        });
    }

    async rejectPaymentRequest(id, adminMeta = {}) {
        const existing = await this.getPaymentRequestById(id);
        if (!existing) throw new Error('Payment request not found');
        if (existing.status === 'APPROVED') throw new Error('Approved payment request cannot be rejected');

        return this.updatePaymentRequest(id, {
            status: 'REJECTED',
            admin_note: adminMeta.adminNote || null,
            approved_by: adminMeta.approvedBy || 'ADMIN'
        });
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
    async saveLog(level, symbol, message, data, userId = null) {
        try {
            const payload = {
                level: level || 'info',
                symbol: symbol || 'SYSTEM',
                message: message || '',
                data: data ? { ...data, userId } : { userId },
                created_at: new Date().toISOString()
            };
            
            const { error } = await this.supabase
                .from('system_logs')
                .insert([payload]);

            if (error) {
                console.error('[SUPABASE LOG ERROR]:', error.message);
            }
        } catch (e) {
            console.error('[CRITICAL LOG ERROR]:', e.message);
        }
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
                .eq('side', tradingMode);

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

    /**
     * Get Invested Capital for a user (Total entry cost of OPEN trades)
     */
    async getInvestedCapitalAmount(userId, tradingMode) {
        try {
            const { data, error } = await supabase
                .from('trades')
                .select('entry_price, quantity')
                .eq('user_id', userId)
                .eq('status', 'OPEN')
                .eq('side', tradingMode);

            if (error) throw error;
            return (data || []).reduce((acc, t) => acc + (Number(t.entry_price) * (t.quantity || 1)), 0);
        } catch (e) {
            return 0;
        }
    }

    /**
     * Calculate LIVE Unrealized P&L for all open positions
     */
    async getLivePnL(userId, tradingMode, angelOneService) {
        try {
            const { data: openTrades, error } = await supabase
                .from('trades')
                .select('*')
                .eq('user_id', userId)
                .eq('status', 'OPEN')
                .eq('side', tradingMode);

            if (error || !openTrades || openTrades.length === 0) return 0;

            const symbols = [...new Set(openTrades.map(t => t.symbol))];
            const quotes = await angelOneService.getMultipleQuotes(symbols);
            const quotesMap = new Map();
            (quotes || []).forEach(q => quotesMap.set(q.tradingSymbol, q));

            let totalPnL = 0;
            for (const trade of openTrades) {
                const quote = quotesMap.get(trade.symbol);
                if (quote) {
                    const ltp = quote.lastTradedPrice;
                    const pnl = (ltp - trade.entry_price) * (trade.type === 'BUY' ? 1 : -1) * (trade.quantity || 1);
                    totalPnL += pnl;
                }
            }
            return totalPnL;
        } catch (e) {
            console.error('[SUPABASE] Live PnL Error:', e.message);
            return 0;
        }
    }



    // --- BROKER CREDENTIALS ---
    
    async getBrokerCredentials(userId) {
        try {
            const { data, error } = await supabase
                .from('broker_credentials')
                .select('*')
                .eq('user_id', userId)
                .eq('broker', 'ANGEL_ONE')
                .single();
            if (error && error.code !== 'PGRST116') throw error;
            return data || null;
        } catch (e) {
            console.error('getBrokerCredentials Error:', e.message);
            return null;
        }
    }

    async updateBrokerCredentials(userId, creds) {
        try {
            const payload = {
                user_id: userId,
                broker: 'ANGEL_ONE',
                client_id: creds.client_id,
                password: creds.password,
                totp_secret: creds.totp_secret,
                api_key: creds.api_key,
                angel_secret: creds.angel_secret,
                telegram_bot_token: creds.telegram_bot_token || null,
                telegram_chat_id: creds.telegram_chat_id || null,
                updated_at: new Date().toISOString()
            };

            const { data: existing } = await supabase
                .from('broker_credentials')
                .select('id')
                .eq('user_id', userId)
                .eq('broker', 'ANGEL_ONE')
                .single();

            if (existing) {
                const { data, error } = await supabase
                    .from('broker_credentials')
                    .update(payload)
                    .eq('id', existing.id)
                    .select()
                    .single();
                if (error) throw error;
                return data;
            } else {
                const { data, error } = await supabase
                    .from('broker_credentials')
                    .insert([payload])
                    .select()
                    .single();
                if (error) throw error;
                return data;
            }
        } catch (e) {
            console.error('updateBrokerCredentials Error:', e.message);
            throw e;
        }
    }
}


module.exports = new SupabaseService();
