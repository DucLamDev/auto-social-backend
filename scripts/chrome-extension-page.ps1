param([ValidateSet('navigate','read')][string]$Action = 'read', [string]$Page = 'diagnostics.html', [string]$Origin = '', [switch]$RestoreNotices, [switch]$OpenOrigin, [switch]$PrepareQuora, [switch]$DryRunQuora)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ChromeWindowFocus { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle); }
'@
$chromeIds = @(Get-Process chrome | ForEach-Object Id)
$roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
foreach ($root in $roots) {
  if ($root.Current.ProcessId -notin $chromeIds) { continue }
  if ($Action -eq 'read') {
    $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem))
    $diagnostics = @($tabs | Where-Object { $_.Current.Name -like 'VPSTTT login diagnostics*' })
    if ($Origin) { $originHost = ([uri]$Origin).Host; $diagnostics = @($diagnostics | Where-Object { $_.Current.Name -like "*$originHost*" }); if (-not $diagnostics.Count) { continue } }
    if ($diagnostics.Count) { $diagnostics[-1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); Start-Sleep -Milliseconds 300 }
    $texts = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text))
    foreach ($textNode in $texts) { if ($textNode.Current.Name -match '^\[\{"tabId"|^\{"origin"|^\[\]$') { $textNode.Current.Name } }
  } else {
    [void][ChromeWindowFocus]::SetForegroundWindow([IntPtr]$root.Current.NativeWindowHandle)
    if ($Page -notin @('diagnostics.html','reload.html','options.html','reconcile.html','extensions')) { throw 'Unknown extension page' }
    $target = if ($Page -eq 'extensions') { 'chrome://extensions/?id=ncahpifofgdghnmipdcnpdfgpbfchiaa' } else { 'chrome-extension://ncahpifofgdghnmipdcnpdfgpbfchiaa/' + $Page }
    if ($RestoreNotices) { if ($Page -ne 'reconcile.html' -or $Origin) { throw 'Notice restoration requires reconcile.html without Origin' }; $target += '?mode=notices' }
    if ($Origin) { $parsedOrigin = [uri]$Origin; if ($parsedOrigin.Scheme -ne 'https') { throw 'HTTPS origin required' }; $target += '?origin=' + [uri]::EscapeDataString($parsedOrigin.GetLeftPart([System.UriPartial]::Authority)) }
    if ($OpenOrigin) { if ($Page -ne 'diagnostics.html' -or -not $Origin) { throw 'OpenOrigin requires diagnostics.html and an HTTPS Origin' }; $target += '&open=1' }
    if ($PrepareQuora) { if ($Page -ne 'diagnostics.html' -or $Origin -ne 'https://www.quora.com') { throw 'PrepareQuora requires diagnostics.html and the Quora origin' }; $target += '&prepareQuora=1' }
    if ($DryRunQuora) { if (-not $PrepareQuora) { throw 'DryRunQuora requires PrepareQuora' }; $target += '&dryRunQuora=1' }
    $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem))
    $existing = @($tabs | Where-Object { $_.Current.Name -like 'VPSTTT login diagnostics*' })
    $currentAddress = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Address and search bar'))
    $ownExtensionPage = $currentAddress -and $currentAddress.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -like '*ncahpifofgdghnmipdcnpdfgpbfchiaa/*'
    if ($existing.Count) {
      $existing[-1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      Start-Sleep -Milliseconds 300
    } elseif (-not $ownExtensionPage) {
      [void][ChromeWindowFocus]::SetForegroundWindow([IntPtr]$root.Current.NativeWindowHandle)
      (New-Object -ComObject WScript.Shell).SendKeys('^t')
      Start-Sleep -Milliseconds 350
      $afterTabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem))
      $blankTabs = @($afterTabs | Where-Object { $_.Current.Name -match '^(New Tab|New tab|Thẻ mới)( -|$)' })
      if ($afterTabs.Count -le $tabs.Count -or -not $blankTabs.Count) { throw 'Could not verify a new blank Chrome tab; existing tabs were not navigated' }
      $blankTabs[-1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    }
    $address = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Address and search bar'))
    if (-not $address) { throw 'Chrome address bar not found' }
    $address.SetFocus()
    $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($target)
    Start-Sleep -Milliseconds 150
    (New-Object -ComObject WScript.Shell).SendKeys('{ENTER}')
    Write-Output 'Extension page opened'
    break
  }
}
