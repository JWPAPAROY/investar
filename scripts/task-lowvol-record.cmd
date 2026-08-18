@echo off
REM ASCII ONLY. cmd.exe reads this file in the OEM codepage (CP949 here),
REM so UTF-8 Korean comments corrupt the file and break execution.
REM
REM Low-volatility observation record (validation only, not production).
REM Must run AFTER the GitHub Actions market-flow collection finishes.
REM Actions cron is 17:50 KST but runner delay (26-55 min) + runtime (26 min)
REM pushes completion to 18:40-19:15 KST, so this task is scheduled at 19:30 KST.
REM At the old 18:30 slot it always read the PREVIOUS day's data.
chcp 65001 >nul
cd /d C:\Users\knoww\investar
echo. >> logs\lowvol-record.log
echo ===== run %DATE% %TIME% ===== >> logs\lowvol-record.log
node scripts\record-lowvol-picks.js --telegram >> logs\lowvol-record.log 2>&1
set RC=%ERRORLEVEL%
echo ----- exit=%RC% ----- >> logs\lowvol-record.log
exit /b %RC%
