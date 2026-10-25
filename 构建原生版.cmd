@echo off
setlocal
"%~dp0app\tools\python\python.exe" -X utf8 -B "%~dp0scripts\project-build.py" Publish
if errorlevel 1 (echo Build failed. & pause & exit /b 1)
echo Build complete.
pause
