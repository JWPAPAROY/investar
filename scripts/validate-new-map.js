require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 새 매핑: KRX 세분류명(가운뎃점 포함) → 검증된 KIS 업종 코드
// 매칭 우선순위: names 배열에 대해 sector_name이 정확히 일치하거나 포함하면 매칭 (위에서부터, 구체적 항목 먼저)
const NEW_MAP=[
 {code:'0013',name:'전기전자',names:['전기·전자','반도체','디스플레이','전자부품','IT부품','LED','2차전지','가전']},
 {code:'0012',name:'기계',names:['기계·장비','기계']},
 {code:'0015',name:'운수장비',names:['운송장비·부품','운송장비','자동차','조선','자동차부품']},
 {code:'0019',name:'운수창고',names:['운송·창고','운수창고','운송','창고','물류']},
 {code:'0016',name:'유통업',names:['유통','도소매','상사']},
 {code:'0014',name:'의료정밀',names:['의료·정밀기기','의료정밀','정밀기기']},
 {code:'0009',name:'의약품',names:['제약','의약품','바이오']},
 {code:'0008',name:'화학',names:['화학','정유','석유화학','비료','플라스틱']},
 {code:'0011',name:'철강금속',names:['금속','비금속','철강','비철금속']},
 {code:'0018',name:'건설업',names:['건설','시멘트','건자재']},
 {code:'0006',name:'섬유의복',names:['섬유·의류','섬유의복','의류','섬유']},
 {code:'0005',name:'음식료품',names:['음식료·담배','음식료','담배','식품']},
 {code:'0007',name:'종이목재',names:['종이·목재','종이목재','종이','목재']},
 {code:'0017',name:'전기가스',names:['전기·가스','전기가스','전력','가스']},
 {code:'0020',name:'통신업',names:['통신']},
 {code:'0021',name:'금융업',names:['금융','증권','보험','은행','카드','캐피탈','지주']},
 {code:'0026',name:'서비스업',names:['IT 서비스','일반서비스','오락·문화','서비스','미디어','엔터','게임','인터넷','플랫폼','교육','레저','오락','문화']},
];
const WORKING=new Set(['0005','0006','0007','0008','0009','0011','0012','0013','0014','0015','0016','0017','0018','0019','0020','0021','0026']);
const mapSector=name=>{
 if(!name)return null;
 for(const e of NEW_MAP){ if(name===e.name) return e; for(const nm of e.names){ if(name.includes(nm)||nm.includes(name)&&nm.length>=2&&name.length>=2) {} if(name.includes(nm)) return e; } }
 return null;
};
(async()=>{
  const since=new Date(Date.now()-180*864e5).toISOString().slice(0,10);
  const recs=[];
  for(let f=0;;f+=1000){const{data}=await sb.from('screening_recommendations').select('sector_name').gte('recommendation_date',since).range(f,f+999);recs.push(...data);if(data.length<1000)break;}
  const cnt={};recs.forEach(r=>{const s=r.sector_name||'(null)';cnt[s]=(cnt[s]||0)+1;});
  console.log('전체 추천 업종명 → 새 매핑 (n 내림차순):');
  let total=0,mapped=0,badcode=0;
  Object.entries(cnt).sort((a,b)=>b[1]-a[1]).forEach(([s,n])=>{
    total+=n;
    if(s==='(null)'){console.log(`  ⬜ ${s.padEnd(18)} n=${n} (정상: null→유지)`);return;}
    const e=mapSector(s);
    if(!e){console.log(`  ❌ ${s.padEnd(18)} n=${n} → 매핑실패`);return;}
    mapped+=n;
    const ok=WORKING.has(e.code);if(!ok)badcode+=n;
    console.log(`  ${ok?'✅':'⚠️'} ${s.padEnd(18)} n=${n} → ${e.code} ${e.name}${ok?'':' (코드死)'}`);
  });
  const nulls=cnt['(null)']||0;
  console.log(`\n총 ${total}건 | 매핑성공 ${mapped}건 (${(mapped/total*100).toFixed(0)}%) | null ${nulls} | 매핑실패 ${total-mapped-nulls} | 죽은코드 ${badcode}`);
})();
