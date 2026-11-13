param([int]$MainPid, [int]$Port, [string]$IconPath)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:mainPid = $MainPid
$script:port = $Port
$script:url = "http://127.0.0.1:$Port"

# 用一个不可见的窗体承载消息循环（Application.Run() 无参会立刻返回，挂不住托盘）
$form = New-Object System.Windows.Forms.Form
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.ShowInTaskbar = $false
$form.Opacity = 0

$notify = New-Object System.Windows.Forms.NotifyIcon
try {
    $notify.Icon = New-Object System.Drawing.Icon($IconPath)
} catch {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = "出差小助手 (端口 $Port)"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add("打开页面")
$itemQuit = $menu.Items.Add("退出")
$notify.ContextMenuStrip = $menu

$itemOpen.Add_Click({ Start-Process $script:url })
$notify.Add_DoubleClick({ Start-Process $script:url })
$itemQuit.Add_Click({
    Stop-Process -Id $script:mainPid -Force -ErrorAction SilentlyContinue
    $form.Close()
})

# 主进程退出后，托盘图标也自动消失
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
    if (-not (Get-Process -Id $script:mainPid -ErrorAction SilentlyContinue)) {
        $timer.Stop()
        $form.Close()
    }
})
$timer.Start()

$form.Show()
$form.Hide()
[System.Windows.Forms.Application]::Run($form)

# Run() 返回后清理
$notify.Visible = $false
$notify.Dispose()
