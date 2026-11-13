# 出差小助手 · 体检
# 由「体检.cmd」调用

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}
$Host.UI.RawUI.WindowTitle = '出差小助手 · 体检'
Set-Location -LiteralPath $PSScriptRoot

Write-Host ''
Write-Host '  ==========================================' -ForegroundColor DarkGray
Write-Host '     出差小助手 · 体检' -ForegroundColor White
Write-Host '  ==========================================' -ForegroundColor DarkGray
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  [X] 没找到 Node.js，请先安装 https://nodejs.org 的 LTS 版本。' -ForegroundColor Red
  Write-Host ''
  Read-Host '  按回车关闭'
  exit 1
}

Write-Host '  [1/2] 高德 key 与各接口' -ForegroundColor Cyan
Write-Host '  ------------------------------------------' -ForegroundColor DarkGray
& node scripts\check-key.mjs
Write-Host ''

Write-Host '  [2/2] 程序自身逻辑' -ForegroundColor Cyan
Write-Host '  ------------------------------------------' -ForegroundColor DarkGray
& node scripts\selftest.mjs
Write-Host ''

Write-Host ''

Write-Host '  ------------------------------------------' -ForegroundColor DarkGray
Write-Host '  以上都没问题，双击「启动.cmd」就能用。' -ForegroundColor Green
Write-Host ''
Read-Host '  按回车关闭窗口'
