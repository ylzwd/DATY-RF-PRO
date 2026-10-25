@echo off
setlocal
"%~dp0app\tools\python\python.exe" -X utf8 -B "%~dp0scripts\project-build.py" Test
if errorlevel 1 (echo Tests failed. & pause & exit /b 1)
echo Tests passed.
pause
