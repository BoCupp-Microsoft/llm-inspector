#!/usr/bin/env pwsh
# Convenience wrapper: ensures mitmproxy (Python Scripts dir) is on PATH, then runs the
# Node launcher. Any arguments are forwarded to `copilot`.
#   .\scripts\start-traced.ps1            # start tracing + copilot
#   .\scripts\start-traced.ps1 --help     # forwards --help to copilot
$ErrorActionPreference = 'Stop'

$scriptsDir = & python -c "import sysconfig;print(sysconfig.get_path('scripts'))" 2>$null
if ($scriptsDir -and (Test-Path $scriptsDir)) {
    $env:PATH = "$scriptsDir;$env:PATH"
}

node (Join-Path $PSScriptRoot 'start-traced.js') @args
