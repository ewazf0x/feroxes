import { ActionError, type Runner } from './run.ts';

/**
 * Windows backends, implemented with Windows PowerShell 5.1 (present on every Windows 10/11 PC) and
 * user32/UI Automation through Add-Type. Scripts are constants; parameters travel as JSON in the
 * FEROXES_ARGS environment variable and are read with ConvertFrom-Json, so command text from the
 * Core is never spliced into PowerShell code. Scripts are passed with -EncodedCommand (UTF-16LE),
 * which also avoids quoting problems.
 */
const PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$a = if ($env:FEROXES_ARGS) { $env:FEROXES_ARGS | ConvertFrom-Json } else { $null }
function Out-Json($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress -Depth 8)) }
`;

const USER32 = `Add-Type -Namespace Fx -Name U32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
[Fx.U32]::SetProcessDPIAware() | Out-Null
`;

export const PS = {
  screenshot: `${USER32}Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$i = if ($null -ne $a.display) { [int]$a.display } else { [Array]::IndexOf($screens, [System.Windows.Forms.Screen]::PrimaryScreen) }
if ($i -lt 0 -or $i -ge $screens.Length) { throw "There is no display $i on this PC (it has $($screens.Length))." }
$b = $screens[$i].Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
$w = [Math]::Min([int]$a.maxWidth, $b.Width); $h = [int][Math]::Round($b.Height * $w / $b.Width)
$out = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($out); $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g2.DrawImage($bmp, 0, 0, $w, $h); $g2.Dispose(); $bmp.Dispose()
$ms = New-Object System.IO.MemoryStream; $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $out.Dispose()
Out-Json @{ mime = 'image/png'; dataBase64 = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $h; scale = ($w / $b.Width); originX = $b.Left; originY = $b.Top; display = $i }`,

  click: `${USER32}[Fx.U32]::SetCursorPos([int]$a.x, [int]$a.y) | Out-Null
Start-Sleep -Milliseconds 30
$down = switch ($a.button) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
$n = if ($a.double) { 2 } else { 1 }
for ($k = 0; $k -lt $n; $k++) { [Fx.U32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [Fx.U32]::mouse_event($down * 2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }
Out-Json @{ clicked = $true; x = [int]$a.x; y = [int]$a.y }`,

  scroll: `${USER32}if ($null -ne $a.x -and $null -ne $a.y) { [Fx.U32]::SetCursorPos([int]$a.x, [int]$a.y) | Out-Null }
if ([int]$a.dy -ne 0) { [Fx.U32]::mouse_event(0x0800, 0, 0, -[int]([double]$a.dy * 1.2), [UIntPtr]::Zero) }
if ([int]$a.dx -ne 0) { [Fx.U32]::mouse_event(0x01000, 0, 0, [int]([double]$a.dx * 1.2), [UIntPtr]::Zero) }
Out-Json @{ scrolled = $true }`,

  // Characters SendKeys treats as commands are wrapped in braces; newlines and tabs become keys.
  type: `Add-Type -AssemblyName System.Windows.Forms
$t = [string]$a.text -replace '([+^%~(){}\\[\\]])', '{$1}'
$t = $t -replace "\`r\`n", '{ENTER}' -replace "\`n", '{ENTER}' -replace "\`t", '{TAB}'
[System.Windows.Forms.SendKeys]::SendWait($t)
Out-Json @{ typed = ([string]$a.text).Length }`,

  keys: `${USER32}$vks = @($a.vks | ForEach-Object { [byte]$_ })
foreach ($vk in $vks) { [Fx.U32]::keybd_event($vk, 0, 0, [UIntPtr]::Zero) }
[Array]::Reverse($vks)
foreach ($vk in $vks) { [Fx.U32]::keybd_event($vk, 0, 2, [UIntPtr]::Zero) }
Out-Json @{ pressed = $a.keys }`,

  clipboardRead: `Out-Json @{ text = [string](Get-Clipboard -Raw) }`,
  clipboardWrite: `Set-Clipboard -Value ([string]$a.text); Out-Json @{ written = ([string]$a.text).Length }`,

  appsList: `$apps = Get-StartApps | Sort-Object Name | ForEach-Object { $_.Name }
Out-Json @{ text = ($apps -join "\`n"); count = @($apps).Count }`,

  // Start-menu apps (desktop and Store) are started through shell:AppsFolder; anything else is a
  // program path or name for Start-Process. Arguments are passed as an array, never parsed.
  appsLaunch: `$name = [string]$a.app
$hit = Get-StartApps | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if (-not $hit) { $hit = Get-StartApps | Where-Object { $_.Name -like "*$([WildcardPattern]::Escape($name))*" } | Select-Object -First 1 }
if ($hit) { Start-Process -FilePath ('shell:AppsFolder\\' + $hit.AppID); Out-Json @{ launched = $hit.Name } }
else {
  $argv = @($a.args | ForEach-Object { [string]$_ })
  if ($argv.Count -gt 0) { Start-Process -FilePath $name -ArgumentList $argv } else { Start-Process -FilePath $name }
  Out-Json @{ launched = $name }
}`,

  windowsList: `${USER32}$fg = [Fx.U32]::GetForegroundWindow()
$wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  [ordered]@{ id = [string][int64]$_.MainWindowHandle; title = $_.MainWindowTitle; app = $_.ProcessName; pid = $_.Id; focused = ($_.MainWindowHandle -eq $fg); minimized = [Fx.U32]::IsIconic($_.MainWindowHandle) } }
$lines = @($wins | ForEach-Object { "[$($_.id)] $($_.app): $($_.title)$(if ($_.focused) { ' (focused)' })$(if ($_.minimized) { ' (minimized)' })" })
Out-Json @{ text = ($lines -join "\`n"); windows = @($wins) }`,

  windowsFocus: `${USER32}Add-Type -AssemblyName Microsoft.VisualBasic
$h = [IntPtr][int64]$a.windowId
if ([Fx.U32]::IsIconic($h)) { [Fx.U32]::ShowWindow($h, 9) | Out-Null }
$ok = [Fx.U32]::SetForegroundWindow($h)
if (-not $ok) { $p = 0; [Fx.U32]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; [Microsoft.VisualBasic.Interaction]::AppActivate([int]$p) }
Out-Json @{ focused = [string][int64]$h }`,

  // UI Automation: the focused (or given) window's control tree, with stable-for-now element ids
  // (runtime ids). Values are truncated; password fields are never read.
  uiTree: `${USER32}Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$h = if ($a.windowId) { [IntPtr][int64]$a.windowId } else { [Fx.U32]::GetForegroundWindow() }
$root = $A::FromHandle($h)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$max = [int]$a.maxNodes; $lines = New-Object System.Collections.Generic.List[string]; $count = 0
function Visit($el, $depth) {
  if ($script:count -ge $max -or $depth -gt 30) { return }
  $c = $el.Current
  $type = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
  $rid = ($el.GetRuntimeId() -join '.')
  $label = $c.Name
  $val = ''
  if (-not $c.IsPassword) { try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $v = [string]$vp.Current.Value; if ($v) { $val = ' = "' + ($(if ($v.Length -gt 120) { $v.Substring(0, 120) + '…' } else { $v })) + '"' } } catch {} }
  $r = $c.BoundingRectangle
  $box = if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { '' } else { " @($([int]$r.X),$([int]$r.Y),$([int]$r.Width)x$([int]$r.Height))" }
  $flags = if (-not $c.IsEnabled) { ' [disabled]' } else { '' }
  $script:lines.Add(('  ' * $depth) + "[$rid] $type" + $(if ($label) { ' "' + $label + '"' } else { '' }) + $val + $box + $flags)
  $script:count++
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child -and $script:count -lt $max) { Visit $child ($depth + 1); $child = $walker.GetNextSibling($child) }
}
Visit $root 0
Out-Json @{ text = ($lines -join "\`n"); count = $count; window = $root.Current.Name; truncated = ($count -ge $max) }`,

  uiAct: `${USER32}Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$P = [System.Windows.Automation.AutomationElementIdentifiers]
$ids = [int[]]@(([string]$a.elementId).Split('.') | ForEach-Object { [int]$_ })
$cond = New-Object System.Windows.Automation.PropertyCondition($P::RuntimeIdProperty, $ids)
$fg = $A::FromHandle([Fx.U32]::GetForegroundWindow())
$el = $fg.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
if (-not $el) { $el = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) }
if (-not $el) { throw "Element $($a.elementId) is gone. Read the UI tree again." }
function Pat($p) { $el.GetCurrentPattern($p) }
switch ($a.action) {
  'invoke' { (Pat ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() }
  'click' { try { (Pat ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch { (Pat ([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() } }
  'set_value' { if ($el.Current.IsPassword) { throw 'Feroxes does not type into password fields.' }; (Pat ([System.Windows.Automation.ValuePattern]::Pattern)).SetValue([string]$a.value) }
  'toggle' { (Pat ([System.Windows.Automation.TogglePattern]::Pattern)).Toggle() }
  'focus' { $el.SetFocus() }
  'expand' { (Pat ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand() }
  'collapse' { (Pat ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Collapse() }
  'select' { (Pat ([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() }
  'scroll_into_view' { (Pat ([System.Windows.Automation.ScrollItemPattern]::Pattern)).ScrollIntoView() }
  'scroll_forward' { (Pat ([System.Windows.Automation.ScrollPattern]::Pattern)).ScrollVertical([System.Windows.Automation.ScrollAmount]::LargeIncrement) }
  'scroll_backward' { (Pat ([System.Windows.Automation.ScrollPattern]::Pattern)).ScrollVertical([System.Windows.Automation.ScrollAmount]::LargeDecrement) }
}
Out-Json @{ done = $a.action; element = $el.Current.Name }`,

  status: `$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$top = Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 | ForEach-Object { "$($_.ProcessName) cpu=$([int]$_.CPU)s mem=$([int]($_.WorkingSet64 / 1MB))MB" }
$locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
Out-Json @{ battery = $(if ($b) { @{ percent = [int]$b.EstimatedChargeRemaining; charging = ($b.BatteryStatus -eq 2 -or $b.BatteryStatus -ge 6) } } else { $null }); top = @($top); locked = $locked }`,

  // A wake timer: a one-off scheduled task with WakeToRun in the owner's task folder. Needs
  // "Allow wake timers" in the power plan (on by default on most PCs when plugged in).
  scheduleWake: `$t = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$a.at).LocalDateTime
if ($t -le (Get-Date)) { throw 'The wake time is in the past.' }
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0'
$trigger = New-ScheduledTaskTrigger -Once -At $t
$trigger.EndBoundary = $t.AddMinutes(30).ToString('s')
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -DeleteExpiredTaskAfter (New-TimeSpan -Hours 1)
$name = 'Wake ' + $t.ToString('yyyy-MM-dd HH.mm')
Register-ScheduledTask -TaskName $name -TaskPath '\\Feroxes\\' -Action $action -Trigger $trigger -Settings $settings -Description ([string]$a.reason) -Force | Out-Null
Out-Json @{ scheduled = $t.ToString('o'); task = '\\Feroxes\\' + $name }`,

  // One long-running helper reports idle time, the foreground app and the lock screen every
  // second, instead of starting PowerShell once per second.
  monitor: `${USER32}Add-Type -Namespace Fx -Name Idle -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
'@
while ($true) {
  $l = New-Object Fx.Idle+LII; $l.cbSize = 8; [Fx.Idle]::GetLastInputInfo([ref]$l) | Out-Null
  $idle = [Math]::Max(0, ([Environment]::TickCount - [int]$l.dwTime)) / 1000.0
  $fgApp = ''; try { $p = 0; [Fx.U32]::GetWindowThreadProcessId([Fx.U32]::GetForegroundWindow(), [ref]$p) | Out-Null; $fgApp = (Get-Process -Id $p).ProcessName } catch {}
  $locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
  [Console]::Out.WriteLine((@{ idle = $idle; app = $fgApp; locked = $locked } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`,

  // DPAPI (CurrentUser): only this Windows account on this PC can decrypt the device token.
  protect: `Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes([string]$a.text)
Out-Json @{ data = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')) }`,
  unprotect: `Add-Type -AssemblyName System.Security
$bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$a.data), $null, 'CurrentUser')
Out-Json @{ text = [Text.Encoding]::UTF8.GetString($bytes) }`,
} as const;

export type PsScript = keyof typeof PS;

/** The full script and its encoded form, as run by powershell.exe -EncodedCommand. */
export function encodePs(name: PsScript): string {
  return Buffer.from(PRELUDE + PS[name], 'utf16le').toString('base64');
}

export function psArgs(name: PsScript): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(name)];
}

export async function runPs<T = Record<string, unknown>>(run: Runner, name: PsScript, args: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const r = await run('powershell.exe', psArgs(name), { env: { FEROXES_ARGS: JSON.stringify(args ?? {}) }, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000, maxBytes: 48 * 1024 * 1024 });
  if (r.timedOut) throw new ActionError('timeout', `${name} took too long.`);
  if (r.code !== 0) throw new ActionError('failed', cleanPsError(r.stderr) || `PowerShell ${name} failed (exit ${r.code}).`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new ActionError('failed', `PowerShell ${name} returned unreadable output.`);
  }
}

/** PowerShell errors carry CLIXML or position noise; keep the first meaningful line. */
export function cleanPsError(stderr: string): string {
  const text = stderr.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '').trim();
  const line = text.split(/\r?\n/).find((l) => l.trim() && !/^\s*(At line|\+|CategoryInfo|FullyQualifiedErrorId)/.test(l));
  return (line ?? text).trim().slice(0, 500);
}

/** Virtual-key codes for input.key (keybd_event). */
const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, space: 0x20,
  printscreen: 0x2c, capslock: 0x14, menu: 0x5d, volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, playpause: 0xb3,
};

export function virtualKeys(keys: string[]): number[] {
  return keys.map((k) => {
    const key = k.toLowerCase().trim();
    if (VK[key] !== undefined) return VK[key]!;
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return 0x6f + Number(key.slice(1));
    if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
    throw new ActionError('bad_params', `Unknown key "${k}". Use names like ctrl, shift, alt, win, enter, tab, esc, f5, a-z, 0-9.`);
  });
}
