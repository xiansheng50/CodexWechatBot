param([string]$NodePath,[string]$CliPath)
$ErrorActionPreference = 'Stop'
$node = (Resolve-Path -LiteralPath $NodePath).Path
$cli = (Resolve-Path -LiteralPath $CliPath).Path
$child = Start-Process -FilePath $node -ArgumentList @(('"' + $cli + '"'), 'start') -WindowStyle Hidden -PassThru -Wait
exit $child.ExitCode
