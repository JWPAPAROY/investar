require('dotenv').config({ path: 'c:\\Users\\knoww\\investar\\.env' });
const https = require('https');
const axios = require('axios');
const kisApi = require('c:\\Users\\knoww\\investar\\backend\\kisApi');

const weights = {
    'KOSPI200F': +0.21,
    '^SOX': +0.15,
    'NQ=F': +0.11,
    'CL=F': -0.11,
    'ES=F': +0.10,
    '^VIX': -0.10,
    'GC=F': +0.08,
    'HG=F': +0.07,
    'USDKRW=X': -0.03,
    '^N225': +0.03,
    '^TNX': -0.01,
};

const TICKERS = Object.keys(weights).filter(t => t !== 'KOSPI200F');

function fetchYahooHistory(symbol, days = 60) {
    return new Promise((resolve, reject) => {
        const period2 = Math.floor(Date.now() / 1000);
        const period1 = period2 - days * 24 * 60 * 60;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;

        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const result = json.chart?.result?.[0];
                    if (!result) return resolve([]);

                    const timestamps = result.timestamp || [];
                    const closes = result.indicators?.quote?.[0]?.close || [];

                    const history = {};
                    for (let i = 0; i < timestamps.length; i++) {
                        if (closes[i] == null) continue;
                        const d = new Date(timestamps[i] * 1000);
                        const dateStr = d.toISOString().slice(0, 10);
                        history[dateStr] = closes[i];
                    }
                    resolve(history);
                } catch (e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

async function fetchKisFuturesHistory() {
    const token = await kisApi.getAccessToken();
    const today = new Date();
    const past = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);

    const formatDate = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    const response = await axios.get(
        `${kisApi.baseUrl}/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice`,
        {
            headers: {
                'Content-Type': 'application/json',
                'authorization': `Bearer ${token}`,
                'appkey': kisApi.appKey,
                'appsecret': kisApi.appSecret,
                'tr_id': 'FHKIF03020100' // 일별 차트
            },
            params: {
                FID_COND_MRKT_DIV_CODE: 'F',
                FID_INPUT_ISCD: '101000',
                FID_INPUT_DATE_1: formatDate(past),
                FID_INPUT_DATE_2: formatDate(today),
                FID_PERIOD_DIV_CODE: 'D'
            }
        }
    );

    const output2 = response.data.output2 || [];
    const history = {};
    for (const item of output2) {
        if (!item.stck_bsop_date) continue;
        const dStr = item.stck_bsop_date;
        const dateStr = `${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}`;
        history[dateStr] = parseFloat(item.stck_clpr);
    }
    return history;
}

// Calculate linear regression slope (Beta)
function calcBeta(x, y) {
    const n = x.length;
    if (n === 0) return 0;

    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

    // slope (m) = (n*ΣXY - ΣX*ΣY) / (n*ΣX^2 - (ΣX)^2)
    const numerator = (n * sumXY) - (sumX * sumY);
    const denominator = (n * sumX2) - (sumX * sumX);

    if (denominator === 0) return 0;
    return numerator / denominator;
}

async function runBetaSim() {
    console.log('데이터 로드...');
    const allData = {};
    for (const t of TICKERS) {
        allData[t] = await fetchYahooHistory(t);
    }
    allData['KOSPI200F'] = await fetchKisFuturesHistory();
    allData['KOSPI'] = await fetchYahooHistory('^KS11');

    const spDates = Object.keys(allData['ES=F']).sort();
    const records = [];

    for (let i = 1; i < spDates.length; i++) {
        const prevDate = spDates[i - 1];
        const currDate = spDates[i];

        const kospiDates = Object.keys(allData['KOSPI']).sort();
        const nextKospiDate = kospiDates.find(d => d > currDate);
        const prevKospiDate = kospiDates.slice().reverse().find(d => d <= currDate);

        if (!nextKospiDate || !prevKospiDate) continue;

        const kospiChange = ((allData['KOSPI'][nextKospiDate] - allData['KOSPI'][prevKospiDate]) / allData['KOSPI'][prevKospiDate]) * 100;

        let score = 0;
        for (const [k, v] of Object.entries(weights)) {
            const curr = allData[k][currDate];
            const prev = allData[k][prevDate];
            if (curr != null && prev != null) {
                const change = ((curr - prev) / prev) * 100;
                score += change * v;
            }
        }

        records.push({ score, kospi: kospiChange });
    }

    const scores = records.map(r => r.score);
    const kospis = records.map(r => r.kospi);

    const beta = calcBeta(scores, kospis);
    console.log(`\n➡️ New Weights Beta (Slope): ${beta.toFixed(3)}`);

    console.log('\n예측 시뮬레이션:');
    console.log(`Score 1.0 -> Predicted KOSPI: ${(1.0 * beta).toFixed(2)}%`);
    console.log(`Score 0.5 -> Predicted KOSPI: ${(0.5 * beta).toFixed(2)}%`);
    console.log(`Score -1.0 -> Predicted KOSPI: ${(-1.0 * beta).toFixed(2)}%`);
}

runBetaSim();
