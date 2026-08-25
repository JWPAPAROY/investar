require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const DAYS = parseInt(process.argv[2]||'90',10);
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const sum=a=>a.reduce((x,y)=>x+y,0);
const fmt=x=>x==null?'N/A':x.toFixed(2);

(async()=>{
  const since=new Date(Date.now()-DAYS*864e5).toISOString().slice(0,10);
  const recs=[];
  for(let f=0;;f+=1000){const{data}=await sb.from('screening_recommendations').select('id,recommendation_date,stock_name,is_top3,total_score,sector_name').gte('recommendation_date',since).order('recommendation_date',{ascending:true}).range(f,f+999);recs.push(...data);if(data.length<1000)break;}
  const ids=recs.map(r=>r.id),pm={};
  for(let i=0;i<ids.length;i+=200){const c=ids.slice(i,i+200);let f=0;while(true){const{data:dp}=await sb.from('recommendation_daily_prices').select('recommendation_id,days_since_recommendation,cumulative_return').in('recommendation_id',c).range(f,f+999);(dp||[]).forEach(p=>{pm[p.recommendation_id]=pm[p.recommendation_id]||{};pm[p.recommendation_id][p.days_since_recommendation]=p.cumulative_return;});if(!dp||dp.length<1000)break;f+=1000;}}
  // STRICT: nearest day <= target, NEVER future. null if no data at/before target.
  const retAt=(id,t)=>{const m=pm[id];if(!m)return null;let b=null,bd=-1;for(const d of Object.keys(m).map(Number)){if(d<=t&&d>bd){bd=d;b=m[d];}}return b;};

  const top3=recs.filter(r=>r.is_top3);
  const byDay={};top3.forEach(r=>{(byDay[r.recommendation_date]=byDay[r.recommendation_date]||[]).push(r);});
  const top1=Object.values(byDay).map(a=>a.sort((x,y)=>y.total_score-x.total_score)[0]);

  console.log(`\n===== 최종 성과 (strict, 최근 ${DAYS}일 since ${since}) =====`);
  for(const[label,set]of[['TOP3',top3],['TOP1',top1]]){
    console.log(`\n--- ${label} (n=${set.length}) ---`);
    for(const o of[1,3,5,10]){const r=set.map(x=>retAt(x.id,o)).filter(v=>v!=null);const w=r.filter(v=>v>0).length;
      console.log(`D+${o}: n=${r.length} 평균=${fmt(mean(r))}% 중앙=${fmt(med(r))}% 승률=${(w/r.length*100).toFixed(0)}%`);}
  }

  // Sector concentration at D+3 (strict)
  console.log(`\n--- TOP3 D+3 업종 집중도 (strict) ---`);
  const sr=id=>retAt(id,3);
  const semi=top3.filter(r=>r.sector_name==='전기·전자').map(r=>sr(r.id)).filter(v=>v!=null);
  const oth=top3.filter(r=>r.sector_name!=='전기·전자').map(r=>sr(r.id)).filter(v=>v!=null);
  const tot=sum(semi)+sum(oth);
  console.log(`전기·전자: n=${semi.length} 평균=${fmt(mean(semi))}% 승률=${(semi.filter(v=>v>0).length/semi.length*100).toFixed(0)}% 수익합=${fmt(sum(semi))}%p (${(sum(semi)/tot*100).toFixed(0)}%)`);
  console.log(`그외: n=${oth.length} 평균=${fmt(mean(oth))}% 승률=${(oth.filter(v=>v>0).length/oth.length*100).toFixed(0)}% 수익합=${fmt(sum(oth))}%p (${(sum(oth)/tot*100).toFixed(0)}%)`);

  // KOSPI benchmark cumulative over window
  const{data:op}=await sb.from('overnight_predictions').select('prediction_date,kospi_close_change').gte('prediction_date',since).order('prediction_date',{ascending:true});
  const kr=(op||[]).map(r=>r.kospi_close_change).filter(v=>v!=null);
  console.log(`\n--- KOSPI 벤치마크 ---`);
  console.log(`일간 평균 ${fmt(mean(kr))}% / 단순누적 ${fmt(sum(kr))}% (n=${kr.length}일)`);
  console.log(`→ TOP3 D+1 평균 ${fmt(mean(top3.map(r=>retAt(r.id,1)).filter(v=>v!=null)))}% vs KOSPI 일간 ${fmt(mean(kr))}% = 알파 ${fmt(mean(top3.map(r=>retAt(r.id,1)).filter(v=>v!=null))-mean(kr))}%p (D+1 기준)`);
})();
