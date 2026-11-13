# 出差小助手 · 改配置
# 由「改配置.cmd」调用

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}
$Host.UI.RawUI.WindowTitle = '出差小助手 · 改配置'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path 'config.json')) {
  Write-Host ''
  Write-Host '  config.json 还不存在，先双击一次「启动.cmd」会自动生成。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '  按回车关闭'
  exit 1
}

Write-Host ''
Write-Host '  接下来会用记事本打开 config.json，改完保存，再重启服务就生效。' -ForegroundColor Gray
Write-Host ''
Write-Host '  常改的几项：' -ForegroundColor White
Write-Host '    amapKey                       高德 key（必须是「Web服务」类型）' -ForegroundColor Gray
Write-Host '    defaults.priceMin / priceMax  默认价格区间，比如 300 / 600' -ForegroundColor Gray
Write-Host '    defaults.radiusKm             默认搜索半径（公里）' -ForegroundColor Gray
Write-Host '    brands                        连锁品牌关键词，加常住品牌就往 keywords 里加' -ForegroundColor Gray
Write-Host ''
Read-Host '  按回车打开 config.json'
Start-Process notepad -ArgumentList (Join-Path $PSScriptRoot 'config.json')
