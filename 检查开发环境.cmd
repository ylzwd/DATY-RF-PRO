@echo off
"%~dp0app\tools\python\python.exe" -X utf8 -B "%~dp0scripts\project-package.py" verify
if errorlevel 1 (echo Check failed. & pause & exit /b 1)
echo Source and offline dependencies verified.
pause
