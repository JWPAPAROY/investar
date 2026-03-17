// Vercel Serverless Function
// GET /api/screening/analyze?codes=005930,000660,402340
// 종목 분석 - 여러 종목코드를 한 번에 분석 (단일 프로세스, Rate Limiter 공유)

const screener = require('../../backend/screening');
const supabase = require('../../backend/supabaseClient');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
            if (!match || match.median <= 0 || match.sample_count < 10) {
              match = expectations.find(e => e.grade === grade && e.whale_detected === !whale);
            }
            if (match && match.median > 0 && match.sample_count >= 30) {
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

    // AI 종목 평가 생성 (Gemini)
    let aiEvaluation = null;
    if (results.length > 0 && process.env.GEMINI_API_KEY) {
      try {
        aiEvaluation = await generateStockEvaluation(results);
      } catch (e) {
        console.warn('⚠️ AI 종목 평가 실패:', e.message);
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
 * Gemini AI 기반 종목 종합 평가
 * 전체 종목 데이터를 한 프롬프트에 넣어 1회 호출
 */
async function generateStockEvaluation(stocks) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // 종목별 핵심 데이터 요약
  const stockSummaries = stocks.map(s => {
    const rec = s.recommendation || {};
    const adv = s.advancedAnalysis?.indicators || {};
    const flow = s.institutionalFlow || {};
    const whale = (adv.whale || []);
    const buyWhale = whale.some(w => w.type?.includes('매수'));
    const sellWhale = whale.some(w => w.type?.includes('매도'));
    const escape = adv.escapeVelocity?.detected;
    const vol = s.volumeAnalysis || {};
    const er = s.expectedReturn;
    const overheat = s.overheatingV2 || {};

    return [
      `[${s.stockName}(${s.stockCode})]`,
      `등급=${rec.grade || '?'} 총점=${s.totalScore || 0}`,
      `Base=${s.scoreBreakdown?.base || 0} Whale=${s.scoreBreakdown?.whale || 0} Momentum=${s.scoreBreakdown?.momentum || 0} Trend=${s.scoreBreakdown?.trend || 0} Signal=${s.scoreBreakdown?.signal || 0}`,
      `등락률=${s.changeRate != null ? s.changeRate + '%' : '?'} 거래량비율=${vol.volumeRatio?.toFixed(1) || '?'}x`,
      `시총=${s.marketCap ? Math.round(s.marketCap / 100000000) + '억' : '?'}`,
      buyWhale ? '매수고래감지' : sellWhale ? '매도고래감지' : '고래없음',
      escape ? '탈출속도달성' : '',
      `기관=${flow.institutionDays || 0}일연속매수 외국인=${flow.foreignDays || 0}일연속매수`,
      `RSI=${overheat.rsi?.toFixed(0) || '?'} 이격도=${overheat.disparity?.toFixed(1) || '?'}`,
      er ? `기대수익(${er.days}일): p25=${er.p25}% 중앙=${er.median}% p75=${er.p75}% 승률=${er.winRate}%` : '',
    ].filter(Boolean).join(', ');
  }).join('\n');

  const prompt = `당신은 한국 주식시장 전문 애널리스트입니다. 아래 종목 분석 데이터를 보고, 각 종목에 대해 매수 판단을 포함한 평가를 해주세요.

[스코어링 체계 안내]
- 총점 0-100점 = Base(기본품질 0-25) + Whale(매수고래 0/15/30) + Momentum(모멘텀 0-30) + Trend(추세 0-15) + Signal(가감)
- 등급: S+(≥90), S(75-89), A(60-74), B(45-59), C(30-44), D(<30), 과열(RSI>85 & 이격도>120)
- 매수고래: 대형 투자자 대량 매수 신호 (+30점 확인됨 / +15점 미확인)
- 탈출속도: 저항선 돌파+강한마감+대량거래 동시 달성 (+5점)
- 기관/외국인 연속매수일: 수급 흐름 판단 핵심 (3일+이면 강력)
- 거래량비율: 1.0-1.5x가 최적(조용한 축적), 5x 이상은 과열 위험
- 기대수익: 동일 등급·조건의 과거 종목 실제 수익률 분포 (p25=하위25%, 중앙값, p75=상위25%)

[분석 데이터]
${stockSummaries}

[출력 형식]
각 종목별로 아래 형식으로 작성:
종목명|판단|한줄평

- 판단은 반드시 다음 중 하나: 적극매수, 매수, 관망, 비추천
- 한줄평은 40자 이내로 핵심만. 매수 이유 또는 비매수 이유를 명확히.
- 판단 기준:
  - 적극매수: A등급 이상 + (매수고래 or 기관≥3일) + 과열 아님
  - 매수: B등급 이상 + 수급 긍정적 + 리스크 관리 가능
  - 관망: 수급 불확실하거나 과열 신호 있거나 C등급
  - 비추천: D등급이거나 매도고래 감지 또는 과열

종목명|판단|한줄평 형식만 출력. 다른 말 없이.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = (await result.response).text().trim();
      if (!text) continue;

      // 파싱: "종목명|판단|한줄평" 형식
      const evaluations = [];
      for (const line of text.split('\n')) {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length >= 3) {
          const stockName = parts[0];
          const verdict = parts[1];
          const comment = parts.slice(2).join('|'); // 한줄평에 | 포함 가능성 대비
          // 종목코드 매칭
          const matched = stocks.find(s =>
            s.stockName === stockName ||
            stockName.includes(s.stockName) ||
            stockName.includes(s.stockCode)
          );
          evaluations.push({
            stockCode: matched?.stockCode || null,
            stockName,
            verdict,
            comment,
          });
        }
      }

      console.log(`✅ AI 종목 평가 완료 (${modelName}): ${evaluations.length}개`);
      return evaluations;
    } catch (err) {
      console.warn(`⚠️ AI 평가 실패 (${modelName}):`, err.message);
      if (err.status === 429) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  return null;
}
