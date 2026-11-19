@echo off
cd /d "%~dp0"
set PORT=8123

where python >nul 2>nul
if %errorlevel%==0 goto runpython

where node >nul 2>nul
if %errorlevel%==0 goto runnode

echo Python or Node.js not found. Please install one of them.
pause
exit /b

:runpython
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%/index.html"
python -m http.server %PORT% --bind 127.0.0.1
goto end

:runnode
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:%PORT%/index.html"
npx --yes serve . -l %PORT%
goto end

:end
