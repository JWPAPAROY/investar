/**
 * 손절가 기능 추가 스크립트
 * index.html에 손절가 표시 기능을 추가합니다.
 */

const fs = require('fs');

// index.html 읽기
let html = fs.readFileSync('index.html', 'utf-8');

// 1. RecommendationCard 컴포넌트에 손절가 계산 및 표시 추가
// 주요 지표 그리드 다음에 손절가 섹션 추가 (line 817 근처)

const stopLossSection = `
            {/* 손절가 정보 (v3.11 NEW) */}
            <div className="mt-3 bg-gradient-to-r from-red-50 to-orange-50 border-2 border-red-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-bold text-red-700">🛡️ 리스크 관리 (손절가 기준)</span>
                <span className="text-xs text-gray-600">추천가 기준</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-white rounded p-2 text-center">
                  <div className="text-gray-600 mb-1">-5% 손절</div>
                  <div className="font-bold text-red-600">{Math.floor(stock.currentPrice * 0.95).toLocaleString()}원</div>
                </div>
                <div className="bg-white rounded p-2 text-center">
                  <div className="text-gray-600 mb-1">-7% 손절</div>
                  <div className="font-bold text-red-700">{Math.floor(stock.currentPrice * 0.93).toLocaleString()}원</div>
                </div>
                <div className="bg-white rounded p-2 text-center">
                  <div className="text-gray-600 mb-1">-10% 손절</div>
                  <div className="font-bold text-red-900">{Math.floor(stock.currentPrice * 0.90).toLocaleString()}원</div>
                </div>
              </div>
              <div className="mt-2 text-xs text-gray-600 text-center">
                💡 손절가 도달 시 매도를 고려하여 손실을 제한하세요
              </div>
            </div>`;

// 주요 지표 섹션 끝 (</div> 3개) 바로 앞에 추가
// "            </div>\n          </div>\n        </div>" 패턴 찾기 (line 816-818)
const indicatorGridEnd = `            </div>
          </div>
        </div>
      );
    }`;

const indicatorGridEndNew = `            </div>${stopLossSection}
          </div>
        </div>
      );
    }`;

// RecommendationCard 컴포넌트의 마지막 부분 교체
if (html.includes(indicatorGridEnd)) {
  html = html.replace(indicatorGridEnd, indicatorGridEndNew);
  console.log('✅ 1. 종목 스크리닝 카드에 손절가 정보 추가 완료');
} else {
  console.log('⚠️  종목 카드의 끝 부분을 찾지 못했습니다. 수동으로 추가가 필요합니다.');
}

// 2. 성과 점검 화면에도 손절가 경고 추가
// PerformanceVerification 컴포넌트 찾기 및 수정

// 성과 종목 카드에 손절가 경고 추가
const perfStockCard = `                  <div className="flex justify-between items-center">
                    <span className="font-medium">{stock.stock_name}</span>
                    <span className={
                      stock.current_return > 0
                        ? 'text-red-600 font-semibold'
                        : stock.current_return < 0
                        ? 'text-blue-600 font-semibold'
                        : 'text-gray-600'
                    }>
                      {stock.current_return > 0 ? '▲' : stock.current_return < 0 ? '▼' : '─'}
                      {' '}{Math.abs(stock.current_return).toFixed(2)}%
                    </span>
                  </div>`;

const perfStockCardNew = `                  <div className="flex justify-between items-center">
                    <span className="font-medium">{stock.stock_name}</span>
                    <div className="text-right">
                      <span className={
                        stock.current_return > 0
                          ? 'text-red-600 font-semibold'
                          : stock.current_return < 0
                          ? 'text-blue-600 font-semibold'
                          : 'text-gray-600'
                      }>
                        {stock.current_return > 0 ? '▲' : stock.current_return < 0 ? '▼' : '─'}
                        {' '}{Math.abs(stock.current_return).toFixed(2)}%
                      </span>
                      {stock.current_price < stock.recommended_price * 0.95 && (
                        <div className="text-xs text-red-600 font-semibold mt-0.5">
                          ⚠️ -5% 손절가 도달
                        </div>
                      )}
                      {stock.current_price < stock.recommended_price * 0.93 && stock.current_price >= stock.recommended_price * 0.95 && (
                        <div className="text-xs text-red-700 font-semibold mt-0.5">
                          🚨 -7% 손절가 도달
                        </div>
                      )}
                      {stock.current_price < stock.recommended_price * 0.90 && (
                        <div className="text-xs text-red-900 font-bold mt-0.5">
                          🔴 -10% 손절가 도달!
                        </div>
                      )}
                    </div>
                  </div>`;

if (html.includes(perfStockCard)) {
  html = html.replace(new RegExp(perfStockCard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), perfStockCardNew);
  console.log('✅ 2. 성과 점검 화면에 손절가 경고 추가 완료');
} else {
  console.log('⚠️  성과 점검 화면의 종목 카드를 찾지 못했습니다.');
}

// 수정된 HTML 저장
fs.writeFileSync('index.html', html, 'utf-8');
console.log('\n✅ index.html 파일 수정 완료!');
console.log('\n📝 변경 사항:');
console.log('  1. 종목 스크리닝 카드: 손절가 정보 표시 (-5%, -7%, -10%)');
console.log('  2. 성과 점검 화면: 손절가 도달 시 경고 표시');
console.log('\n🚀 다음 단계: git add, commit, push를 진행하세요');
