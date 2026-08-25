require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const kisApi = require('../backend/kisApi');
// 표준 KOSPI 업종 인덱스 코드 추정표
const CANDIDATES={
 '0001':'KOSPI종합','0005':'음식료품','0006':'섬유의복','0007':'종이목재','0008':'화학',
 '0009':'의약품','0010':'비금속광물','0011':'철강금속','0012':'기계','0013':'전기전자',
 '0014':'의료정밀','0015':'운수장비','0016':'유통업','0017':'전기가스','0018':'건설업',
 '0019':'운수창고','0020':'통신업','0021':'금융업','0022':'은행','0024':'증권','0025':'보험','0026':'서비스업',
};
(async()=>{
  await kisApi.getAccessToken();
  for(const[code,guess]of Object.entries(CANDIDATES)){
    try{
      const ch=await kisApi.getIndexChart(code,5);
      if(ch&&ch.length>=2){
        const chg=((ch[0].close-ch[1].close)/ch[1].close*100).toFixed(2);
        console.log(`${code} (${guess}): ✅ n=${ch.length} 최신종가=${ch[0].close} (${ch[0].date}) 1d=${chg}%`);
      }else console.log(`${code} (${guess}): ⚠️ 데이터부족 (n=${ch?ch.length:0})`);
    }catch(e){console.log(`${code} (${guess}): ❌ ${e.message}`);}
  }
})();
