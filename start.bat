@echo off
chcp 65001 >nul 2>&1
title 1Shell - One Shell to rule them all

set "NODE_EXE=node"
if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"

echo.
echo  +================================================+
echo  ^|         1Shell v4.3.0                          ^|
echo  ^|     One Shell to rule them all.                ^|
echo  +================================================+
echo.

:: Check Node.js
"%NODE_EXE%" -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 20-24 or use the bundled Windows release package.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

:: Check Node.js version
for /f "tokens=1 delims=v" %%i in ('"%NODE_EXE%" -v') do set "NODE_VER=%%i"
for /f "tokens=1 delims=." %%i in ('"%NODE_EXE%" -v') do set "NODE_MAJOR=%%i"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 20 (
    echo [ERROR] Unsupported Node.js version. 1Shell requires Node.js 20-24.
    pause
    exit /b 1
)
if %NODE_MAJOR% GEQ 25 (
    echo [ERROR] Unsupported Node.js version. 1Shell requires Node.js 20-24.
    pause
    exit /b 1
)
echo [1Shell] Node.js %NODE_MAJOR% detected

:: Check backend dependencies
if not exist "node_modules\" (
    echo [1Shell] First run - installing backend dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo [1Shell] Backend dependencies installed
)

:: Build frontend when the production bundle is missing
if not exist "frontend\dist\index.html" (
    if not exist "frontend\package.json" (
        echo [ERROR] frontend\package.json not found
        pause
        exit /b 1
    )
    echo [1Shell] Frontend bundle missing - installing frontend dependencies...
    pushd frontend
    if not exist "node_modules\" (
        call npm install
        if %errorlevel% neq 0 (
            popd
            echo [ERROR] frontend npm install failed
            pause
            exit /b 1
        )
    )
    echo [1Shell] Building frontend bundle...
    call npm run build
    if %errorlevel% neq 0 (
        popd
        echo [ERROR] frontend build failed
        pause
        exit /b 1
    )
    popd
    echo [1Shell] Frontend bundle ready
)

:: Check .env
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        "%NODE_EXE%" -e "const fs=require('fs');const crypto=require('crypto');fs.appendFileSync('.env','\nAPP_SECRET='+crypto.randomBytes(32).toString('hex')+'\n')"
        if not errorlevel 1 (
            echo [1Shell] Generated APP_SECRET for credential encryption
        )
        echo [1Shell] Created .env from .env.example
        echo [1Shell] Please edit .env to set password and API Key
        echo.
    )
)

:: Start server
echo [1Shell] Starting server...
echo [1Shell] URL: http://localhost:3301
echo [1Shell] Default login: admin / admin
echo [1Shell] Press Ctrl+C to stop
echo.
"%NODE_EXE%" server.js
