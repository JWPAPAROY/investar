@echo off
REM 저변동성 관측 픽 일일 기록 (검증 전용 — 실운영 무관)
REM 시장 데이터 수집(GitHub Actions 평일 17:50 KST) 이후 실행되어야 함.
cd /d C:\Users\knoww\investar
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set STAMP=%DT:~0,8%
node scripts\record-lowvol-picks.js --telegram >> logs\lowvol-record.log 2>&1
echo [%STAMP%] exit=%ERRORLEVEL% >> logs\lowvol-record.log
