/**
 * 예측 Scaling 백테스팅 스크립트
 * 
 * Supabase의 historical prediction 데이터를 사용하여
 * 다양한 Beta/Sigma 설정이 실제 KOSPI 변동률을 얼마나 잘 커버하는지 분석
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const supabase = require('../backend/supabaseClient');

const DEFAULT_KOSPI_BETA = 2.5;

// ── 현재 v1.4 스케일링 ──
function calcExpectedChange_v14(score, beta, sigma) {
    let b = beta || DEFAULT_KOSPI_BETA;
    if (Math.abs(score) > 1.2) {
        const floorBeta = 2.0 + (Math.abs(score) - 1.2) * 2.0;
        if (b < floorBeta) b = floorBeta;
    }
    const band = sigma || 1.5;
    const center = +(score * b).toFixed(2);
    let dynamicBand = band;
    if (Math.abs(score) > 1.2) {
        dynamicBand = Math.max(band, Math.abs(score) * 2.0);
    }
    return { min: +(center - dynamicBand).toFixed(2), max: +(center + dynamicBand).toFixed(2), beta: +b.toFixed(2), sigma: +dynamicBand.toFixed(2) };
}

// ── 보수적 v1.2 스케일링 (이전 버전) ──
function calcExpectedChange_v12(score, beta, sigma) {
    let b = beta || DEFAULT_KOSPI_BETA;
    if (Math.abs(score) > 1.2) {
        const floorBeta = 1.5 + (Math.abs(score) - 1.2) * 1.2;
        if (b < floorBeta) b = floorBeta;
    }
    const band = sigma || 1.5;
    const center = +(score * b).toFixed(2);
    let dynamicBand = band;
    if (Math.abs(score) > 1.2) {
        dynamicBand = Math.max(band, Math.abs(score) * 1.5);
    }
    return { min: +(center - dynamicBand).toFixed(2), max: +(center + dynamicBand).toFixed(2), beta: +b.toFixed(2), sigma: +dynamicBand.toFixed(2) };
}

// ── 기본 (스케일링 없음) ──
function calcExpectedChange_default(score, beta, sigma) {
    const b = beta || DEFAULT_KOSPI_BETA;
    const band = sigma || 1.5;
    const center = +(score * b).toFixed(2);
    return { min: +(center - band).toFixed(2), max: +(center + band).toFixed(2), beta: +b.toFixed(2), sigma: +band.toFixed(2) };
}

// ── 제안: 중간 공격성 v1.5 ──
function calcExpectedChange_v15(score, beta, sigma) {
    let b = beta || DEFAULT_KOSPI_BETA;
    if (Math.abs(score) > 1.2) {
        const floorBeta = 1.8 + (Math.abs(score) - 1.2) * 1.5;
        if (b < floorBeta) b = floorBeta;
    }
    const band = sigma || 1.5;
    const center = +(score * b).toFixed(2);
    let dynamicBand = band;
    if (Math.abs(score) > 1.2) {
        dynamicBand = Math.max(band, Math.abs(score) * 1.8);
    }
    return { min: +(center - dynamicBand).toFixed(2), max: +(center + dynamicBand).toFixed(2), beta: +b.toFixed(2), sigma: +dynamicBand.toFixed(2) };
}

async function runBacktest() {
    console.log('📊 예측 Scaling 백테스팅 시작...\n');

    // 1. Supabase에서 실제 결과가 있는 예측 데이터 가져오기
    const { data, error } = await supabase
        .from('overnight_predictions')
        .select('prediction_date, score, signal, kospi_close_change, hit')
        .not('kospi_close_change', 'is', null)
        .neq('signal', 'TOKEN_CACHE')
        .order('prediction_date', { ascending: true });

    if (error || !data || data.length === 0) {
        console.error('❌ 데이터 조회 실패:', error?.message || 'No data');
        return;
    }

    console.log(`📈 총 ${data.length}개 거래일 데이터 로드 완료\n`);

    // 2. 각 스케일링 전략별 백테스트
    const strategies = [
        { name: '기본 (No Scale)', fn: calcExpectedChange_default },
        { name: 'v1.2 보수적', fn: calcExpectedChange_v12 },
        { name: 'v1.4 초공격 (현재)', fn: calcExpectedChange_v14 },
        { name: 'v1.5 중간 (제안)', fn: calcExpectedChange_v15 },
    ];

    const results = strategies.map(({ name, fn }) => {
        let inRange = 0;
        let directionHit = 0;
        let totalBandWidth = 0;
        let outlierMiss = 0; // |score| > 1.2인 날 miss
        let outlierHit = 0;  // |score| > 1.2인 날 hit
        let outlierCount = 0;
        const details = [];

        for (const row of data) {
            const score = +row.score;
            const actual = +row.kospi_close_change;
            const range = fn(score);
            const bandWidth = range.max - range.min;
            totalBandWidth += bandWidth;

            const isInRange = actual >= range.min && actual <= range.max;
            const dirCorrect = (score > 0 && actual > 0) || (score < 0 && actual < 0) || (Math.abs(score) < 0.15 && Math.abs(actual) < 1);

            if (isInRange) inRange++;
            if (dirCorrect) directionHit++;

            const isOutlier = Math.abs(score) > 1.2;
            if (isOutlier) {
                outlierCount++;
                if (isInRange) outlierHit++;
                else outlierMiss++;
            }

            details.push({
                date: row.prediction_date,
                score: score.toFixed(3),
                actual: actual.toFixed(2),
                range: `${range.min.toFixed(1)} ~ ${range.max.toFixed(1)}`,
                band: bandWidth.toFixed(1),
                beta: range.beta,
                hit: isInRange ? '✅' : '❌',
                isOutlier,
            });
        }

        return {
            name,
            total: data.length,
            inRange,
            hitRate: ((inRange / data.length) * 100).toFixed(1),
            directionHit,
            dirHitRate: ((directionHit / data.length) * 100).toFixed(1),
            avgBandWidth: (totalBandWidth / data.length).toFixed(2),
            outlierCount,
            outlierHit,
            outlierMiss,
            outlierHitRate: outlierCount > 0 ? ((outlierHit / outlierCount) * 100).toFixed(1) : 'N/A',
            details,
        };
    });

    // 3. 결과 요약 출력
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  📊 스케일링 전략별 백테스트 결과 요약');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(padRight('전략', 22), padRight('범위적중률', 12), padRight('방향적중률', 12), padRight('평균밴드폭', 12), padRight('아웃라이어적중', 16));
    console.log('─'.repeat(76));

    for (const r of results) {
        console.log(
            padRight(r.name, 22),
            padRight(`${r.inRange}/${r.total} (${r.hitRate}%)`, 12),
            padRight(`${r.directionHit}/${r.total} (${r.dirHitRate}%)`, 12),
            padRight(`${r.avgBandWidth}%p`, 12),
            padRight(`${r.outlierHit}/${r.outlierCount} (${r.outlierHitRate}%)`, 16),
        );
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');

    // 4. 현재 v1.4 전략의 상세 결과 (아웃라이어만)
    const currentV14 = results.find(r => r.name.includes('v1.4'));
    if (currentV14) {
        console.log('\n📋 v1.4 (현재) 아웃라이어(|score|>1.2) 상세:');
        console.log(padRight('날짜', 12), padRight('스코어', 8), padRight('실제%', 10), padRight('예측범위', 22), padRight('밴드폭', 8), padRight('적중', 4));
        console.log('─'.repeat(66));
        for (const d of currentV14.details.filter(d => d.isOutlier)) {
            console.log(padRight(d.date, 12), padRight(d.score, 8), padRight(d.actual + '%', 10), padRight(d.range, 22), padRight(d.band + '%p', 8), d.hit);
        }
    }

    // 5. v1.5 (제안)의 아웃라이어 상세
    const proposedV15 = results.find(r => r.name.includes('v1.5'));
    if (proposedV15) {
        console.log('\n📋 v1.5 (제안) 아웃라이어(|score|>1.2) 상세:');
        console.log(padRight('날짜', 12), padRight('스코어', 8), padRight('실제%', 10), padRight('예측범위', 22), padRight('밴드폭', 8), padRight('적중', 4));
        console.log('─'.repeat(66));
        for (const d of proposedV15.details.filter(d => d.isOutlier)) {
            console.log(padRight(d.date, 12), padRight(d.score, 8), padRight(d.actual + '%', 10), padRight(d.range, 22), padRight(d.band + '%p', 8), d.hit);
        }
    }

    // 6. 전체 일자별 비교 (모든 전략)
    console.log('\n📋 전체 거래일별 범위적중 비교:');
    console.log(padRight('날짜', 12), padRight('스코어', 8), padRight('실제%', 10), padRight('기본', 5), padRight('v1.2', 5), padRight('v1.4', 5), padRight('v1.5', 5));
    console.log('─'.repeat(54));
    for (let i = 0; i < data.length; i++) {
        console.log(
            padRight(data[i].prediction_date, 12),
            padRight((+data[i].score).toFixed(3), 8),
            padRight((+data[i].kospi_close_change).toFixed(2) + '%', 10),
            results[0].details[i].hit,
            results[1].details[i].hit,
            results[2].details[i].hit,
            results[3].details[i].hit,
        );
    }

    console.log('\n✅ 백테스팅 완료!');
}

function padRight(str, len) {
    const s = String(str);
    const byteLen = Buffer.byteLength(s, 'utf8');
    const charLen = s.length;
    const extraBytes = byteLen - charLen;
    return s.padEnd(len - Math.floor(extraBytes / 2));
}

runBacktest().catch(console.error);
