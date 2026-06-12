@echo off
echo ============================================
echo   SUBINDO O BACKEND DA API (F5-API)
echo ============================================
cd C:\Projetos\www\f5-api
git add -A
git commit -m "feat: estabilidade martingale e nomenclatura dinamica no robo de padroes"
git push https://f5novacursos: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@github.com/f5novacursos/f5-api.git main
echo.
echo ============================================
echo   Concluido! Verifique se deu 'main -> main' acima.
echo ============================================
pause
