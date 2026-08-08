@echo off
REM 2026-09-16 저변동성 정식 판정 — 실시간 기록 집계 + 백테스트 재실행
cd /d C:\Users\knoww\investar
echo ================ VERDICT RUN %DATE% %TIME% ================ >> logs\lowvol-verdict.log
node scripts\record-lowvol-picks.js --review              >> logs\lowvol-verdict.log 2>&1
node scripts\alt-funnel-backtest.js                       >> logs\lowvol-verdict.log 2>&1
node scripts\alt-funnel-backtest.js --k=20 --look=20      >> logs\lowvol-verdict.log 2>&1
node scripts\pool-slice-scan.js                           >> logs\lowvol-verdict.log 2>&1
echo [DONE] exit=%ERRORLEVEL% >> logs\lowvol-verdict.log
