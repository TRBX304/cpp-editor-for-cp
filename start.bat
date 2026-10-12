@echo off
rem Local Judge (C / C++) launcher - runs the server inside WSL (Ubuntu)
cd /d "%~dp0"

rem Open the browser after the server has had time to start
start "" /b cmd /c "timeout /t 2 > nul & start http://localhost:2435"

rem bash -ic so that node installed via nvm is found
wsl.exe --cd "%~dp0." -- bash -ic "node backend/server.js"
pause