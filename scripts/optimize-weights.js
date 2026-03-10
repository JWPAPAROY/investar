require('dotenv').config({ path: 'c:\\Users\\knoww\\investar\\.env' });
const https = require('https');
const axios = require('axios');
const kisApi = require('c:\\Users\\knoww\\investar\\backend\\kisApi');

const TICKERS = [
    'ES=F', 'NQ=F', 'GC=F', 'HG=F', 'CL=F',
    '^SOX', '^VIX', 'USDKRW=X', '^TNX', '^N225'
];

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

// Statistics helpers
function calCorrelation(x, y) {
    const n = x.length;
    if (n === 0) return 0;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const num = (n * sumXY) - (sumX * sumY);
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (den === 0) return 0;
    return num / den;
}

async function runBacktest() {
    console.log('초기화 중... 데이터 수집 시작');

    const allData = {};
    for (const t of TICKERS) {
        allData[t] = await fetchYahooHistory(t);
    }
    allData['KOSPI200F'] = await fetchKisFuturesHistory();
    allData['KOSPI'] = await fetchYahooHistory('^KS11');

    // Get sorted trading days based on S&P500
    const spDates = Object.keys(allData['ES=F']).sort();

    const records = [];

    for (let i = 1; i < spDates.length; i++) {
        const prevDate = spDates[i - 1];
        const currDate = spDates[i];

        // Find next day KOSPI change
        // Since US market closes on currDate, Korean market opens on next trading day
        // We will look for KOSPI data on the earliest date > currDate
        const kospiDates = Object.keys(allData['KOSPI']).sort();
        const nextKospiDate = kospiDates.find(d => d > currDate);
        const prevKospiDate = kospiDates.slice().reverse().find(d => d <= currDate);

        if (!nextKospiDate || !prevKospiDate) continue;

        const kospiChange = ((allData['KOSPI'][nextKospiDate] - allData['KOSPI'][prevKospiDate]) / allData['KOSPI'][prevKospiDate]) * 100;

        const row = { date: currDate, kospiNextChange: kospiChange };
        let valid = true;

        for (const t of [...TICKERS, 'KOSPI200F']) {
            const curr = allData[t][currDate];
            const prev = allData[t][prevDate];
            if (curr == null || prev == null) {
                row[t] = 0; // fallback
            } else {
                row[t] = ((curr - prev) / prev) * 100;
            }
        }

        if (valid) records.push(row);
    }

    console.log(`총 ${records.length}거래일 분석 완료.\n`);

    console.log('--- 항목별 다중공선성 및 KOSPI 상관계수 ---');
    const y = records.map(r => r.kospiNextChange);

    for (const t of [...TICKERS, 'KOSPI200F']) {
        const x = records.map(r => r[t]);
        const corr = calCorrelation(x, y);
        console.log(`${t.padEnd(10)}: KOSPI 상관계수 = ${corr > 0 ? '+' : ''}${corr.toFixed(3)}`);
    }

    // Score simulation with current weights
    const weights = {
        'KOSPI200F': +0.28,
        'ES=F': +0.18,
        'NQ=F': +0.15,
        'GC=F': -0.04,
        'HG=F': +0.05,
        'CL=F': +0.03,
        '^SOX': +0.08,
        '^VIX': -0.08,
        'USDKRW=X': -0.08,
        '^TNX': -0.04,
        '^N225': +0.04,
    };

    let scoreArr = [];
    for (const r of records) {
        let score = 0;
        for (const [k, v] of Object.entries(weights)) {
            score += (r[k] || 0) * v;
        }
        scoreArr.push(score);
    }

    const scoreCorr = calCorrelation(scoreArr, y);

    // Calculate average KOSPI change for different score bands
    const bands = [
        { name: 'Strong Bullish', min: 0.5, max: Infinity, count: 0, sum: 0 },
        { name: 'Mild Bullish', min: 0.2, max: 0.5, count: 0, sum: 0 },
        { name: 'Neutral', min: -0.2, max: 0.2, count: 0, sum: 0 },
        { name: 'Mild Bearish', min: -0.5, max: -0.2, count: 0, sum: 0 },
        { name: 'Strong Bearish', min: -Infinity, max: -0.5, count: 0, sum: 0 },
    ];

    for (let i = 0; i < records.length; i++) {
        const s = scoreArr[i];
        const actual = y[i];
        for (const b of bands) {
            if (s >= b.min && s < b.max) {
                b.count++;
                b.sum += actual;
            }
        }
    }

    console.log(`\n--- 현재 가중치 기반 예측 스코어 성과 ---`);
    console.log(`스코어 <-> KOSPI 상관계수 (Beta 역할): +${scoreCorr.toFixed(3)}`);
    console.log('\n--- 예측 밴드별 실제 KOSPI 평균 변동률 ---');
    for (const b of bands) {
        const avg = b.count > 0 ? (b.sum / b.count).toFixed(2) : 'N/A';
        console.log(`${b.name.padEnd(15)} (${b.count}일): 평균 ${avg > 0 ? '+' : ''}${avg}%`);
    }

    // Simple optimization: what should the bands actually be?
    const sortedScores = [...scoreArr].sort((a, b) => b - a);
    const q20 = sortedScores[Math.floor(sortedScores.length * 0.2)] || 0;
    const q40 = sortedScores[Math.floor(sortedScores.length * 0.4)] || 0;
    const q60 = sortedScores[Math.floor(sortedScores.length * 0.6)] || 0;
    const q80 = sortedScores[Math.floor(sortedScores.length * 0.8)] || 0;

    console.log('\n--- 데이터 분포 기반 추천 밴드 (상위 20%/40%/60%/80%) ---');
    console.log(`Strong Bullish (상위 20%): > ${q20.toFixed(2)}`);
    console.log(`Mild Bullish   (상위 40%): > ${q40.toFixed(2)}`);
    console.log(`Neutral        (중위 20%): ${q60.toFixed(2)} ~ ${q40.toFixed(2)}`);
    console.log(`Mild Bearish   (하위 40%): < ${q60.toFixed(2)}`);
    console.log(`Strong Bearish (하위 20%): < ${q80.toFixed(2)}`);

}

runBacktest();
