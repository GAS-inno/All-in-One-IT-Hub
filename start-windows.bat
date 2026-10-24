@echo off
cd /d "%~dp0"
py server.py
if errorlevel 1 pause
