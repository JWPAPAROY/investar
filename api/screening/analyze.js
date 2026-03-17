// Vercel Serverless Function
// GET /api/screening/analyze?codes=005930,000660,402340
// 종목 분석 - 여러 종목코드를 한 번에 분석 (단일 프로세스, Rate Limiter 공유)

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  // codes (복수) 또는 code (단일) 파라미터 지원
  const codesParam = req.query.codes || req.query.code || '';
  const codes = codesParam.match(/\d{6}/g);
  if (!codes || codes.length === 0) {
    return res.status(400).json({ success: false, error: '6자리 종목코드를 입력해주세요 (예: codes=005930,000660)' });
  }

  const uniqueCodes = [...new Set(codes)].slice(0, 15); // 최대 15개
  console.log(`🔍 종목 분석: ${uniqueCodes.length}개 [${uniqueCodes.join(', ')}]`);

  try {
    const kisApi = require('../../backend/kisApi');

    // v3.46: 기대수익 통계 조회
    let expectations = [];
    try {
      const { data } = await supabase.from('expected_return_stats').select('*');
      expectations = data || [];
    } catch(e) {}

    // 1단계: 종목명 사전 확보 — Supabase 우선, 없으면 KIS API getStockName fallback
    const nameMap = new Map();

    // 1-1: Supabase에서 종목명 일괄 조회 (가장 빠르고 안정적)
    try {
      const { data: dbNames } = await supabase
        .from('screening_recommendations')
        .select('stock_code, stock_name')
        .in('stock_code', uniqueCodes)
        .not('stock_name', 'is', null)
        .order('recommendation_date', { ascending: false });
      dbNames?.forEach(r => {
        if (!nameMap.has(r.stock_code) && r.stock_name && !r.stock_name.startsWith('[')) {
          nameMap.set(r.stock_code, r.stock_name);
        }
      });
      console.log(`📋 Supabase 종목명: ${nameMap.size}개`);
    } catch (e) {
      console.warn('⚠️ Supabase 종목명 조회 실패:', e.message);
    }

    // 1-2: Supabase에 없는 종목은 KIS API getStockName으로 개별 조회
    const missingCodes = uniqueCodes.filter(c => !nameMap.has(c));
    for (const code of missingCodes) {
      try {
        const name = await kisApi.getStockName(code);
        if (name) {
          nameMap.set(code, name);
          console.log(`📋 KIS API 종목명: ${code} → ${name}`);
        }
      } catch (e) { /* ignore */ }
    }

    // kisApi 내부 캐시에도 저장 (getCurrentPrice에서 활용)
    if (!kisApi.stockNameCache) kisApi.stockNameCache = new Map();
    nameMap.forEach((name, code) => kisApi.stockNameCache.set(code, name));

    // 2단계: 종목 순차 분석
    const results = [];
    const errors = [];

    for (const code of uniqueCodes) {
      try {
        let result = await screener.analyzeStock(code);

        // 실패 시 1회 재시도
        if (!result) {
          console.log(`⚠️ [${code}] 1차 분석 실패, 500ms 후 재시도...`);
          await new Promise(r => setTimeout(r, 500));
          result = await screener.analyzeStock(code);
        }

        if (result) {
          // 종목명 보완: 없거나 [코드] 형태이거나 6자리 숫자(코드 자체)인 경우
          if (!result.stockName || result.stockName.startsWith('[') || /^\d{6}$/.test(result.stockName)) {
            const name = nameMap.get(code);
            if (name) result.stockName = name;
          }
          // v3.46: 기대수익 구간 매칭
          if (expectations.length > 0) {
            const grade = result.recommendation?.grade;
            const whale = result.advancedAnalysis?.indicators?.whale?.some(w => w.type === '매수고래') || false;
            let match = expectations.find(e => e.grade === grade && e.whale_detected === whale);
            if (!match || match.sample_count < 5) {
              match = expectations.find(e => e.grade === grade && e.whale_detected === !whale);
            }
            if (match && match.sample_count >= 5) {
              result.expectedReturn = { days: match.optimal_days, p25: +match.p25, median: +match.median, p75: +match.p75, winRate: +match.win_rate, sampleCount: match.sample_count, updatedAt: match.updated_at };
            }
          }
          results.push(result);
        } else {
          errors.push({ code, error: 'KIS API 응답 실패 또는 차트 데이터 부족' });
        }
      } catch (err) {
        errors.push({ code, error: err.message });
      }
    }

    // 규칙 기반 종목 평가
    let aiEvaluation = null;
    if (results.length > 0) {
      try {
        aiEvaluation = generateRuleBasedEvaluation(results);
      } catch (e) {
        console.warn('⚠️ 종목 평가 실패:', e.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: results,
      aiEvaluation,
      errors: errors.length > 0 ? errors : undefined,
      total: uniqueCodes.length,
      analyzed: results.length
    });
  } catch (error) {
    console.error('종목 분석 실패:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * 규칙 기반 종목 종합 평가
 * 스코어링 데이터에서 직접 판단 + 한줄평 생성
 */
function generateRuleBasedEvaluation(stocks) {
  const evaluations = [];

  for (const s of stocks) {
    const rec = s.recommendation || {};
    const grade = rec.grade || 'D';
    const adv = s.advancedAnalysis?.indicators || {};
    const flow = s.institutionalFlow || {};
    const whaleList = adv.whale || [];
    const buyWhale = whaleList.some(w => w.type?.includes('매수'));
    const sellWhale = whaleList.some(w => w.type?.includes('매도'));
    const escape = adv.escapeVelocity?.detected;
    const vol = s.volumeAnalysis || {};
    const volRatio = vol.volumeRatio || 0;
    const overheat = s.overheatingV2 || {};
    const rsi = overheat.rsi || 0;
    const disparity = overheat.disparity || 100;
    const instDays = flow.institutionDays || 0;
    const foreignDays = flow.foreignDays || 0;
    const totalScore = s.totalScore || 0;
    const er = s.expectedReturn;

    const isOverheat = grade === '과열' || (rsi > 85 && disparity > 120);
    const gradeRank = { 'S+': 6, 'S': 5, 'A': 4, 'B': 3, 'C': 2, 'D': 1, '과열': 0 };
    const rank = gradeRank[grade] ?? 1;
    const hasStrongSupply = instDays >= 3 || foreignDays >= 3;
    const hasSupply = instDays >= 1 || foreignDays >= 1;
    const hasDualSupply = instDays >= 2 && foreignDays >= 2;

    // 판단 로직
    let verdict;
    if (isOverheat || (sellWhale && rank <= 2)) {
      verdict = '비추천';
    } else if (rank <= 1) {
      verdict = '비추천';
    } else if (rank >= 4 && (buyWhale || hasStrongSupply) && !isOverheat) {
      verdict = '적극매수';
    } else if (rank >= 3 && hasSupply && volRatio < 5) {
      verdict = '매수';
    } else if (rank >= 3 && buyWhale) {
      verdict = '매수';
    } else {
      verdict = '관망';
    }

    // 한줄평 생성
    const reasons = [];
    if (verdict === '비추천') {
      if (isOverheat) reasons.push(`RSI ${rsi.toFixed(0)} 과열`);
      if (sellWhale) reasons.push('매도고래 감지');
      if (rank <= 1 && !isOverheat && !sellWhale) reasons.push(`${grade}등급, 진입 근거 부족`);
    } else if (verdict === '적극매수') {
      if (buyWhale) reasons.push('매수고래');
      if (escape) reasons.push('탈출속도');
      if (hasStrongSupply) {
        const parts = [];
        if (instDays >= 3) parts.push(`기관${instDays}일`);
        if (foreignDays >= 3) parts.push(`외인${foreignDays}일`);
        reasons.push(parts.join('+') + ' 연속매수');
      }
      if (hasDualSupply) reasons.push('쌍방수급');
      reasons.push(`${grade}등급 ${totalScore}점`);
    } else if (verdict === '매수') {
      if (buyWhale) reasons.push('매수고래');
      if (hasSupply) {
        const parts = [];
        if (instDays >= 1) parts.push(`기관${instDays}일`);
        if (foreignDays >= 1) parts.push(`외인${foreignDays}일`);
        reasons.push(parts.join('+') + ' 매수');
      }
      if (volRatio >= 1.0 && volRatio <= 1.5) reasons.push('조용한 축적');
      reasons.push(`${grade}등급 ${totalScore}점`);
    } else {
      // 관망
      if (rank <= 2) reasons.push(`${grade}등급`);
      if (!hasSupply && !buyWhale) reasons.push('수급 부재');
      if (volRatio >= 5) reasons.push(`거래량 ${volRatio.toFixed(1)}배 과열`);
      if (rsi > 70) reasons.push(`RSI ${rsi.toFixed(0)} 고위`);
      if (reasons.length === 0) reasons.push('추가 확인 필요');
    }

    // 기대수익 정보 추가 (적극매수/매수에만)
    if (er && (verdict === '적극매수' || verdict === '매수')) {
      reasons.push(`기대+${er.median}%(${er.days}일)`);
    }

    const comment = reasons.join(', ').slice(0, 50);

    evaluations.push({
      stockCode: s.stockCode || null,
      stockName: s.stockName || s.stockCode,
      verdict,
      comment,
    });
  }

  console.log(`✅ 규칙 기반 종목 평가: ${evaluations.length}개`);
  return evaluations;
}
