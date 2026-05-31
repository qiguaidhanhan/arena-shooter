@echo off
chcp 65001 >nul
echo.
echo ═══════════════════════════════════════
echo   竞技场射手 - 联机服务器
echo ═══════════════════════════════════════
echo.
echo 正在启动服务器...
echo.

REM 优先用Python，其次Node.js
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] 使用 Python 启动
    python server.py %*
    goto end
)

node --version >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] 使用 Node.js 启动
    node server.js %*
    goto end
)

echo [✗] 未找到 Python 或 Node.js！
echo.
echo 请安装以下任一运行环境：
echo   - Python 3.6+: https://www.python.org/downloads/
echo   - Node.js: https://nodejs.org/
echo.
echo 安装后双击此文件重新启动。
pause

:end
