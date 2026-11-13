# 出差小助手 · 启动器
# 由「启动.cmd」调用，不要直接双击本文件

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}
$Host.UI.RawUI.WindowTitle = '出差小助手'
Set-Location -LiteralPath $PSScriptRoot

function Write-Banner {
  Write-Host ''
  Write-Host '  ==========================================' -ForegroundColor DarkGray
  Write-Host '     出差小助手 · 厂家周边酒店' -ForegroundColor White
  Write-Host '  ==========================================' -ForegroundColor DarkGray
}

Write-Banner

# ---- 1. Node.js 在不在 ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '  [X] 没找到 Node.js' -ForegroundColor Red
  Write-Host ''
  Write-Host '      这个工具需要 Node.js 18 以上版本。' -ForegroundColor Gray
  Write-Host '      去 https://nodejs.org 下载 LTS 版，安装时一路点「下一步」，' -ForegroundColor Gray
  Write-Host '      装完重新双击「启动.cmd」即可。' -ForegroundColor Gray
  Write-Host ''
  Read-Host '  按回车关闭'
  exit 1
}

# ---- 2. 启动前检查（会处理 key）----
& node scripts\preflight.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  启动前检查没通过，按上面的提示处理后，再双击「启动.cmd」。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '  按回车关闭'
  exit 1
}

# ---- 3. 起服务，窗口保持打开 ----
Write-Host '  正在启动服务…' -ForegroundColor DarkGray
& node server.mjs --open
$code = $LASTEXITCODE

Write-Host ''
if ($code -ne 0) {
  Write-Host "  服务异常退出（退出码 $code）。" -ForegroundColor Red
  Write-Host '  想看详细原因，双击「体检.cmd」。' -ForegroundColor Gray
} else {
  Write-Host '  服务已停止。' -ForegroundColor Yellow
}
Write-Host ''
Read-Host '  按回车关闭窗口'
