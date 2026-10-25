@echo off
"%~dp0app\tools\python\python.exe" -X utf8 -B "%~dp0scripts\project-package.py" export
if errorlevel 1 (echo Export failed. & pause & exit /b 1)
echo Export complete. See delivery folder.
pause
