# Running the Feroxes Core 24/7

These templates keep the Core thinking in the background, even when the desktop window is closed.
The desktop app then **attaches** to it instead of starting its own (see
[docs/08](../../../docs/08-desktop-app.md)). Pick the one for your OS, edit the two paths, install.

All three run the same command — `node <repo>/apps/core/src/cli.ts serve` — and rely on the Core
defaulting its data directory to the shared per-user config dir, so the app and this service share
one brain. Put your API keys in `<config-dir>/feroxes/.env` (see docs/08).

## Linux (systemd user service)

```bash
# edit paths in feroxes.service first
mkdir -p ~/.config/systemd/user
cp feroxes.service ~/.config/systemd/user/feroxes.service
systemctl --user daemon-reload
systemctl --user enable --now feroxes.service
loginctl enable-linger "$USER"     # keep it running after logout / in sleep-friendly setups
systemctl --user status feroxes    # check it started
```

## macOS (launchd LaunchAgent)

```bash
# edit paths in dev.feroxes.core.plist first
cp dev.feroxes.core.plist ~/Library/LaunchAgents/dev.feroxes.core.plist
launchctl load -w ~/Library/LaunchAgents/dev.feroxes.core.plist
launchctl list | grep feroxes
```

## Windows (Task Scheduler)

Run once in PowerShell (edit the two paths):

```powershell
$node = "C:\Program Files\nodejs\node.exe"
$cli  = "C:\path\to\feroxes\apps\core\src\cli.ts"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" serve"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
Register-ScheduledTask -TaskName "Feroxes Core" -Action $action -Trigger $trigger -Settings $settings
```

To stop and remove: `Unregister-ScheduledTask -TaskName "Feroxes Core" -Confirm:$false`.
