#!/usr/bin/env pwsh
# First-time setup wrapper. Prepends the Python Scripts dir to PATH (so mitmdump is found),
# then runs the Node setup script (installs mitmproxy, generates the CA, builds the viewer).
$ErrorActionPreference = 'Stop'

$scriptsDir = & python -c "import sysconfig;print(sysconfig.get_path('scripts'))" 2>$null
if ($scriptsDir -and (Test-Path $scriptsDir)) {
    $env:PATH = "$scriptsDir;$env:PATH"
}

node (Join-Path $PSScriptRoot 'setup.js') @args
