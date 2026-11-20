@echo off
cd /d "%~dp0"
set PORT=8123

where python >nul 2>nul
if %errorlevel%==0 goto runpython

where node >nul 2>nul
if %errorlevel%==0 goto runnode

echo 未找到 Python 或 Node.js，请先安装其中一个。
pause
exit /b

:runpython
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%/index.html"
python "%~dp0serve.py" --port %PORT%
goto end

:runnode
echo 没有 Python，退回 node 静态服务（无 gzip，首次加载会慢一些）
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:%PORT%/index.html"
npx --yes serve . -l %PORT%
goto end

:end
