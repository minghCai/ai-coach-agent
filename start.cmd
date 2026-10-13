@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。
  echo 请先安装 Node.js 20 或更高版本，并确认已加入系统 PATH。
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   万象棋 AI 教练 - 本地服务
echo   地址：http://127.0.0.1:8787
echo   关闭本窗口即停止服务（数据已保存在 data\ 目录）
echo ============================================
echo.

rem 服务起来后自动打开浏览器（延迟 2 秒，避免抢跑）
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"

node web\serve.mjs

echo.
echo 服务已停止。
pause
