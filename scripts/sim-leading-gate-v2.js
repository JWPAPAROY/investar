require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const kisApi = require('../backend/kisApi');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const DAYS=parseInt(process.argv[2]||'120',10);
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const fmt=x=>x==null?'N/A':x.toFixed(2);const wr=a=>a.length?(a.filter(v=>v>0).length/a.length*100).toFixed(0):'NA';const sum=a=>a.reduce((x,y)=>x+y,0);
const NEW_MAP=[
 {code:'0013',name:'전기전자',names:['전기·전자','반도체','디스플레이','전자부품','IT부품','LED','2차전지','가전']},
 {code:'0012',name:'기계',names:['기계·장비','기계']},
 {code:'0015',name:'운수장비',names:['운송장비·부품','운송장비','자동차','조선']},
 {code:'0019',name:'운수창고',names:['운송·창고','운수창고','운송','창고','물류']},
 {code:'0016',name:'유통업',names:['유통','도소매','상사']},
 {code:'0014',name:'의료정밀',names:['의료·정밀기기','의료정밀','정밀기기']},
 {code:'0009',name:'의약품',names:['제약','의약품','바이오']},
 {code:'0008',name:'화학',names:['화학','정유','석유화학']},
 {code:'0011',name:'철강금속',names:['금속','비금속','철강']},
 {code:'0018',name:'건설업',names:['건설','시멘트','건자재']},
 {code:'0006',name:'섬유의복',names:['섬유·의류','섬유의복','의류','섬유']},
 {code:'0005',name:'음식료품',names:['음식료·담배','음식료','담배','식품']},
 {code:'0007',name:'종이목재',names:['종이·목재','종이목재','종이','목재']},
 {code:'0017',name:'전기가스',names:['전기·가스','전기가스','전력','가스']},
 {code:'0020',name:'통신업',names:['통신']},
 {code:'0021',name:'금융업',names:['금융','증권','보험','은행','카드','캐피탈','지주']},
 {code:'0026',name:'서비스업',names:['IT 서비스','일반서비스','오락·문화','서비스','미디어','엔터','게임','인터넷','플랫폼','교육','레저','오락','문화']},
];
const mapCode=name=>{if(!name)return null;for(const e of NEW_MAP){if(name===e.name)return e.code;for(const nm of e.names)if(name.includes(nm))return e.code;}return null;};
(async()=>{
  await kisApi.getAccessToken();
  const codes=['0001',...new Set(NEW_MAP.map(s=>s.code))];
  const cm={};
  for(const code of codes){let ok=false;for(let att=0;att<4&&!ok;att++){try{const ch=await kisApi.getIndexChart(code,DAYS+15);const m={};ch.forEach(c=>{if(c.date&&c.close)m[c.date]=c.close;});cm[code]={m,dates:Object.keys(m).sort()};ok=true;}catch(e){await new Promise(r=>setTimeout(r,600));}}if(!ok)console.log("지수 최종실패",code);}
  const ich=(code,T)=>{const o=cm[code];if(!o)return null;const ds=o.dates.filter(d=>d<=T);if(ds.length<2)return null;const c0=o.m[ds[ds.length-1]],c1=o.m[ds[ds.length-2]],c3=ds.length>=4?o.m[ds[ds.length-4]]:c1;return{ch1:(c0-c1)/c1*100,ch3:ds.length>=4?(c0-c3)/c3*100/3:(c0-c1)/c1*100};};
  const lead=(name,T)=>{const code=mapCode(name);if(!code)return null;const s=ich(code,T),k=ich('0001',T);if(!s||!k)return null;return +((s.ch3-k.ch3)*0.4+(s.ch1-k.ch1)*0.6).toFixed(3);};

  const since=new Date(Date.now()-DAYS*864e5).toISOString().slice(0,10);
  const recs=[];
  for(let f=0;;f+=1000){const{data}=await sb.from('screening_recommendations').select('id,recommendation_date,is_top3,sector_name').gte('recommendation_date',since).order('recommendation_date',{ascending:true}).range(f,f+999);recs.push(...data);if(data.length<1000)break;}
  const ids=recs.map(r=>r.id),pm={};
  for(let i=0;i<ids.length;i+=200){const c=ids.slice(i,i+200);let f=0;while(true){const{data:dp}=await sb.from('recommendation_daily_prices').select('recommendation_id,days_since_recommendation,cumulative_return').in('recommendation_id',c).range(f,f+999);(dp||[]).forEach(p=>{pm[p.recommendation_id]=pm[p.recommendation_id]||{};pm[p.recommendation_id][p.days_since_recommendation]=p.cumulative_return;});if(!dp||dp.length<1000)break;f+=1000;}}
  const cum=(id,t)=>{const m=pm[id];if(!m)return null;let b=null,bd=-1;for(const d of Object.keys(m).map(Number))if(d<=t&&d>bd){bd=d;b=m[d];}return b;};
  const realized=(id,bu,se)=>{const e=cum(id,bu),x=cum(id,se);if(e==null||x==null)return null;return((1+x/100)/(1+e/100)-1)*100;};
  const top3=recs.filter(r=>r.is_top3&&realized(r.id,1,10)!=null);
  top3.forEach(r=>{r.ret=realized(r.id,1,10);r.ls=lead(r.sector_name,r.recommendation_date.replace(/-/g,''));});
  const st=set=>{const r=set.map(x=>x.ret);return `n=${set.length} 평균=${fmt(mean(r))}% 중앙=${fmt(med(r))}% 승률=${wr(r)}% 누적=${fmt(sum(r))}%p`;};
  console.log(`\n===== 수정 매핑 leading_score 게이트 백테스트 (D+1→D+10) =====`);
  console.log(`[원본] 전체 TOP3: ${st(top3)}`);
  console.log(`[커버리지] ls산출 ${top3.filter(r=>r.ls!=null).length}/${top3.length} (${(top3.filter(r=>r.ls!=null).length/top3.length*100).toFixed(0)}%)\n`);
  for(const thr of [0,0.5,1.0,1.5]){
    const kept=top3.filter(r=>r.ls==null||r.ls>thr),drop=top3.filter(r=>r.ls!=null&&r.ls<=thr);
    console.log(`--- leading_score > ${thr} (null=유지) ---\n  통과: ${st(kept)}\n  차단: ${st(drop)}`);
  }
})();
