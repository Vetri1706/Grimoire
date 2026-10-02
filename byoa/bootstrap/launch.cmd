@echo off
setlocal
set "GRIMOIRE_BOOTSTRAP=%~dp0bootstrap\windows.ps1"
if exist "%~dp0windows.ps1" set "GRIMOIRE_BOOTSTRAP=%~dp0windows.ps1"
rem This policy applies to this one PowerShell process, never the machine or user.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%GRIMOIRE_BOOTSTRAP%" %*
set "GRIMOIRE_EXIT=%ERRORLEVEL%"
if not "%GRIMOIRE_EXIT%"=="0" pause
exit /b %GRIMOIRE_EXIT%
