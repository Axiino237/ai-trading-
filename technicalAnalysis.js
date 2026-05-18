class TechnicalAnalysis {
    /**
     * Exponential Moving Average (EMA)
     */
    calculateEMA(candles, period) {
        if (!candles || candles.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = candles[0][4]; // Initial seed
        for (let i = 1; i < candles.length; i++) {
            ema = (candles[i][4] * k) + (ema * (1 - k));
        }
        return ema;
    }

    /**
     * Relative Strength Index (RSI)
     */
    calculateRSI(candles, period = 14) {
        if (!candles || candles.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = candles[i][4] - candles[i - 1][4];
            if (diff >= 0) gains += diff; else losses -= diff;
        }
        let avgGain = gains / period, avgLoss = losses / period;
        for (let i = period + 1; i < candles.length; i++) {
            const diff = candles[i][4] - candles[i - 1][4];
            avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
            avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
        }
        return avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    }

    /**
     * MACD
     */
    calculateMACD(candles) {
        if (candles.length < 26) return { macd: 0, signal: 0, histogram: 0 };
        const ema12 = this.calculateEMA(candles, 12);
        const ema26 = this.calculateEMA(candles, 26);
        const macd = ema12 - ema26;
        // Signal line is EMA 9 of MACD (Simplified here, in reality would need a window of MACD values)
        const signal = macd * 0.8; // Rough approximation for single candle
        return { macd, signal, histogram: macd - signal };
    }

    /**
     * Volume Average
     */
    calculateAvgVolume(candles, period = 20) {
        if (candles.length < period) return 0;
        const slice = candles.slice(-period);
        const sum = slice.reduce((acc, c) => acc + c[5], 0);
        return sum / period;
    }

    /**
     * Candlestick Pattern: Hammer
     */
    isHammer(candle) {
        const [t, o, h, l, c, v] = candle;
        const body = Math.abs(c - o);
        const lowerShadow = Math.min(o, c) - l;
        const upperShadow = h - Math.max(o, c);
        return lowerShadow >= 2 * body && upperShadow <= 0.1 * lowerShadow;
    }

    /**
     * Candlestick Pattern: Engulfing
     */
    isBullishEngulfing(prev, curr) {
        const [pt, po, ph, pl, pc, pv] = prev;
        const [ct, co, ch, cl, cc, cv] = curr;
        return (pc < po) && (cc > co) && (cc > po) && (co < pc);
    }

    isBearishEngulfing(prev, curr) {
        const [pt, po, ph, pl, pc, pv] = prev;
        const [ct, co, ch, cl, cc, cv] = curr;
        return (pc > po) && (cc < co) && (cc < po) && (co > pc);
    }

    isInvertedHammer(candle) {
        const [t, o, h, l, c, v] = candle;
        const body = Math.abs(c - o);
        const upperShadow = h - Math.max(o, c);
        const lowerShadow = Math.min(o, c) - l;
        return upperShadow >= 2 * body && lowerShadow <= 0.1 * upperShadow;
    }

    /**
     * Support / Resistance detection (Simple Swing method)
     */
    getLevels(candles) {
        const prices = candles.map(c => c[4]);
        const support = Math.min(...prices.slice(-20));
        const resistance = Math.max(...prices.slice(-20));
        return { support, resistance };
    }

    /**
     * Trend Detection
     */
    getTrend(emaShort, emaLong) {
        if (emaShort > emaLong) return 'UP';
        if (emaShort < emaLong) return 'DOWN';
        return 'SIDEWAYS';
    }

    /**
     * Final Rule Check - Dual Mode
     */
    checkRules(data, mode = 'STRICT') {
        if (mode === 'OFF') {
            return {
                pass: false,
                side: 'NONE',
                details: { isBuy: false, isSell: false, logic: 'OFF' }
            };
        }

        const { ema9, ema20, ema50, rsi, macd, volume, avgVolume, candles } = data;

        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];

        const bullishPattern = this.isHammer(lastCandle) || this.isBullishEngulfing(prevCandle, lastCandle);
        const bearishPattern = this.isInvertedHammer(lastCandle) || this.isBearishEngulfing(prevCandle, lastCandle);

        if (mode === 'STRICT') {
            // Bullish Check
            const trendBullish = ema9 > ema20 && ema20 > ema50;
            const rsiBullish = rsi > 50 && rsi < 70;
            const volBullish = volume > 1.5 * avgVolume;
            const isBuy = trendBullish && rsiBullish && volBullish && bullishPattern;

            // Bearish Check
            const trendBearish = ema9 < ema20 && ema20 < ema50;
            const rsiBearish = rsi < 50 && rsi > 30;
            const volBearish = volume > 1.5 * avgVolume;
            const isSell = trendBearish && rsiBearish && volBearish && bearishPattern;

            return {
                pass: isBuy || isSell,
                side: isBuy ? 'BUY' : (isSell ? 'SELL' : 'NONE'),
                details: { isBuy, isSell }
            };
        } else {
            // SMART RELAXED MODE - Tuned for quality breakouts
            const trendUp = ema9 > ema20;
            const trendDown = ema9 < ema20;

            // Check MACD Momentum (Directional)
            const macdBullish = macd.histogram > 0 && macd.macd > macd.signal;
            const macdBearish = macd.histogram < 0 && macd.macd < macd.signal;

            // Volume must be at least 25% higher than average for a valid entry signal
            const volOk = volume > 1.25 * avgVolume;
            
            // Tighter RSI to avoid entering at the absolute top/bottom
            const rsiOkBullish = rsi > 50 && rsi < 68; 
            const rsiOkBearish = rsi < 50 && rsi > 32;

            // Entry logic: Basic trend + volume + momentum + strict RSI
            const isBuy = trendUp && rsiOkBullish && (volOk || bullishPattern) && macdBullish;
            const isSell = trendDown && rsiOkBearish && (volOk || bearishPattern) && macdBearish;

            return {
                pass: isBuy || isSell,
                side: isBuy ? 'BUY' : (isSell ? 'SELL' : 'NONE'),
                details: { isBuy, isSell, logic: 'SMART_RELAXED' }
            };
        }
    }
}

module.exports = new TechnicalAnalysis();
