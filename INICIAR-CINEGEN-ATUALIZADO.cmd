@echo off
setlocal
title CineGen IA v3.0 - Servidor Atualizado
cd /d "%~dp0"

echo.
echo ==========================================
echo   CINEGEN IA - VERSAO ATUALIZADA
echo ==========================================
echo.
echo Compilando o projeto...
call npm.cmd run build
if errorlevel 1 (
  echo.
  echo A compilacao falhou. Leia a mensagem acima.
  pause
  exit /b 1
)

echo.
echo Abrindo http://localhost:3003/
start "" "http://localhost:3003/"
echo.
echo Mantenha esta janela aberta enquanto usar o CineGen.
echo Pressione Ctrl+C para encerrar o servidor.
echo.
call npm.cmd run preview -- --host 0.0.0.0 --port 3003

endlocal
