const { SmartAPI } = require('smartapi-javascript');
const axios = require('axios');
require('dotenv').config();

class AngelOneService {
    constructor() {
        this.smartApi = null;
        this.sessionData = null;
        this.symbolMaster = [];
        this.isMasterLoading = false;
        this.masterUrl = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';
    }

    async loadSymbolMaster() {
        if (this.symbolMaster.length > 0) return;
        if (this.isMasterLoading) {
            while (this.isMasterLoading) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
        }
        this.isMasterLoading = true;
        try {
            console.log('[ANGEL] Downloading Symbol Master...');
            const response = await axios.get(this.masterUrl, { timeout: 30000 });
            this.symbolMaster = response.data;
            console.log(`[ANGEL] Symbol Master Loaded: ${this.symbolMaster.length} instruments ✅`);
        } catch (error) {
            console.error('[ANGEL] Failed to load symbol master:', error.message);
        } finally {
            this.isMasterLoading = false;
        }
    }

    async login(clientId, password, totpSecret) {
        try {
            const finalClientId = clientId || process.env.ANGEL_ONE_CLIENT_ID;
            const finalPassword = password || process.env.ANGEL_ONE_MPIN;
            const finalTotpSecret = totpSecret || process.env.ANGEL_ONE_TOTP_SECRET;

            const { TOTP } = require('totp-generator');
            const { otp: totpToken } = await TOTP.generate(finalTotpSecret);
            
            this.smartApi = new SmartAPI({
                api_key: process.env.ANGEL_ONE_API_KEY,
            });

            const data = await this.smartApi.generateSession(finalClientId, finalPassword, totpToken);
            
            if (data.status) {
                this.sessionData = data.data;
                console.log('Angel One Login Successful! ✅');
                this.loadSymbolMaster();
                return { success: true, data: this.sessionData };
            } else {
                throw new Error(data.message || 'Login failed');
            }
        } catch (error) {
            console.error('Angel One Login Error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async searchScrip(exchange, symbol) {
        await this.loadSymbolMaster();
        const query = symbol.toUpperCase();
        
        const exact = this.symbolMaster.find(item => 
            item.exch_seg === exchange && item.symbol === query
        );
        
        if (exact) return { data: [this.mapItem(exact)] };

        const results = this.symbolMaster
            .filter(item => 
                item.exch_seg === exchange && 
                (item.symbol.includes(query) || (item.name && item.name.toUpperCase().includes(query)))
            )
            .slice(0, 50)
            .map(item => this.mapItem(item));

        return { data: results };
    }

    mapItem(item) {
        return {
            tradingSymbol: item.symbol,
            symbolToken: item.token,
            name: item.name,
            exchSeg: item.exch_seg
        };
    }

    async ensureSession() {
        if (!this.smartApi || !this.sessionData) {
            await this.login();
        }
    }

    async getQuote(symbol, exchange = 'NSE') {
        await this.ensureSession();
        try {
            const cleanSym = symbol.replace('-EQ', '').toUpperCase();
            await this.loadSymbolMaster();
            const scrip = this.symbolMaster.find(item => 
                item.exch_seg === exchange && (
                    item.symbol.toUpperCase() === symbol.toUpperCase() || 
                    item.symbol.toUpperCase() === `${cleanSym}-EQ` ||
                    item.symbol.toUpperCase() === cleanSym
                )
            ) || this.symbolMaster[0];
            const token = scrip.token || scrip.symbolToken;

            // PRECISE HEADERS for Angel One Market Data
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserType': 'USER',
                'X-SourceID': 'WEB',
                'X-ClientLocalIP': '127.0.0.1',
                'X-ClientPublicIP': '127.0.0.1',
                'X-MACAddress': '00-00-00-00-00-00',
                'X-PrivateKey': process.env.ANGEL_ONE_API_KEY,
                'Authorization': `Bearer ${this.sessionData.jwtToken}`
            };

            const response = await axios.post(
                'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote',
                {
                    mode: "FULL",
                    exchangeTokens: { [exchange]: [token] }
                },
                { headers }
            ).catch(err => {
                console.error('[ANGEL API REJECTION]:', err.response?.data || err.message);
                throw err;
            });

            if (response.data.status && response.data.data && response.data.data.fetched && response.data.data.fetched.length > 0) {
                const quote = response.data.data.fetched[0];
                return {
                    ...quote,
                    lastTradedPrice: quote.ltp,
                    symbolToken: token,
                    tradingSymbol: scrip.tradingSymbol
                };
            } else {
                if (response.data.errorcode === 'AG8001' || response.data.message === 'Invalid Token') {
                    console.log('[ANGEL] Token expired, refreshing session...');
                    this.sessionData = null;
                    return this.getQuote(symbol, exchange);
                }
                throw new Error(response.data.message || 'Failed to fetch quote');
            }
        } catch (error) {
            console.error('Market Data Error:', error.response?.data?.message || error.message);
            throw error;
        }
    }
    async getMultipleQuotes(symbols, exchange = 'NSE') {
        await this.ensureSession();
        try {
            const tokens = [];
            const tokenToSymbol = {};

            for (const symbol of symbols) {
                const cleanSym = symbol.replace('-EQ', '').toUpperCase();
                // Local search in symbolMaster
                await this.loadSymbolMaster();
                const scrip = this.symbolMaster.find(item => 
                    item.exch_seg === exchange && (
                        item.symbol.toUpperCase() === symbol.toUpperCase() || 
                        item.symbol.toUpperCase() === `${cleanSym}-EQ` ||
                        item.symbol.toUpperCase() === cleanSym
                    )
                );
                
                if (scrip) {
                    tokens.push(scrip.token);
                    tokenToSymbol[scrip.token] = symbol;
                }
            }

            if (tokens.length === 0) return [];

            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserType': 'USER',
                'X-SourceID': 'WEB',
                'X-ClientLocalIP': '127.0.0.1',
                'X-ClientPublicIP': '127.0.0.1',
                'X-MACAddress': '00-00-00-00-00-00',
                'X-PrivateKey': process.env.ANGEL_ONE_API_KEY,
                'Authorization': `Bearer ${this.sessionData.jwtToken}`
            };

            const response = await axios.post(
                'https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote',
                {
                    mode: "FULL",
                    exchangeTokens: { [exchange]: tokens }
                },
                { headers }
            ).catch(err => {
                if (err.response?.status === 403) {
                    console.error('[ANGEL] Rate Limit Hit in Batch Quote');
                }
                throw err;
            });

            if (response.data.status && response.data.data && response.data.data.fetched) {
                return response.data.data.fetched.map(q => ({
                    ...q,
                    lastTradedPrice: q.ltp,
                    tradingSymbol: tokenToSymbol[q.symbolToken] || q.tradingSymbol
                }));
            }
            return [];
        } catch (error) {
            console.error('[ANGEL] Batch Quote Error:', error.message);
            return [];
        }
    }

    async getRMSBalance() {
        await this.ensureSession();
        try {
            const response = await this.smartApi.getRMS();
            return response.data;
        } catch (error) {
            return null;
        }
    }

    async getUserRMSBalance(userCreds) {
        try {
            const { SmartAPI } = require('smartapi-javascript');
            const { TOTP } = require('totp-generator');
            
            const userApi = new SmartAPI({ api_key: userCreds.api_key });
            const { otp: totpToken } = await TOTP.generate(userCreds.totp_secret);
            const loginRes = await userApi.generateSession(userCreds.client_id, userCreds.password, totpToken);
            
            if (!loginRes.status) return null;

            const response = await userApi.getRMS();
            return response.data;
        } catch (error) {
            console.error('getUserRMSBalance error:', error.message);
            return null;
        }
    }

    async placeOrder(symbol, symbolToken, quantity, side, type = "LIMIT", price = 0) {
        await this.ensureSession();
        try {
            const response = await this.smartApi.placeOrder({
                variety: "NORMAL",
                tradingsymbol: symbol,
                symboltoken: symbolToken,
                transactiontype: side.toUpperCase(),
                exchange: "NSE",
                ordertype: type,
                producttype: "CARRYFORWARD",
                duration: "DAY",
                price: price.toString(),
                squareoff: "0",
                stoploss: "0",
                quantity: quantity.toString()
            });
            return response;
        } catch (error) {
            throw error;
        }
    }

    async getCandleData(symbol, interval = 'ONE_MINUTE', days = 1) {
        await this.ensureSession();
        try {
            let token = symbol;
            let exchange = 'NSE';
            if (isNaN(symbol)) {
                const cleanSym = symbol.replace('-EQ', '');
                const scripResult = await this.searchScrip(exchange, cleanSym);
                if (!scripResult.data || scripResult.data.length === 0) throw new Error(`Symbol ${symbol} not found`);
                
                const scrip = scripResult.data.find(s => s.tradingSymbol === symbol || s.tradingSymbol === `${cleanSym}-EQ`) || scripResult.data[0];
                token = scrip.symbolToken;
                exchange = scrip.exchSeg || 'NSE';
            }

            const toDate = new Date();
            const fromDate = new Date();
            fromDate.setDate(toDate.getDate() - days);

            const formatDate = (date) => {
                const pad = (n) => n.toString().padStart(2, '0');
                return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
            };

            const response = await this.smartApi.getCandleData({
                exchange: exchange,
                symboltoken: token,
                interval: interval,
                fromdate: formatDate(fromDate),
                todate: formatDate(toDate)
            });
            return response.data;
        } catch (error) {
            throw error;
        }
    }
}

module.exports = new AngelOneService();
