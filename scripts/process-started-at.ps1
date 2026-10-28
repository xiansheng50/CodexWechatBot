param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
if (-not $processInfo -or -not $processInfo.CreationDate) {
    throw 'Cannot verify process creation time'
}
$processInfo.CreationDate.ToUniversalTime().ToString('o')
