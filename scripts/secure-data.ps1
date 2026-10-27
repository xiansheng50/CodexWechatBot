param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$target = (Resolve-Path -LiteralPath $Directory).Path
if ((Get-Item -LiteralPath $target -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing a reparse-point data directory' }
# Inspect without traversing links before changing any permissions.
$children = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
$pending = [System.Collections.Generic.Queue[string]]::new()
$pending.Enqueue($target)
while ($pending.Count -gt 0) {
  foreach ($child in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
    if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to secure a tree containing reparse points' }
    $children.Add($child)
    if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
  }
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
foreach ($identity in @($sid, $system)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inheritance, $propagation, 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($target, $acl)
# Existing files may carry explicit permissions; replace them with inheritance
# from this protected root as well. No files outside the requested tree are used.
$children | ForEach-Object {
  if ($_.PSIsContainer) { $childAcl = [System.IO.Directory]::GetAccessControl($_.FullName) }
  else { $childAcl = [System.IO.File]::GetAccessControl($_.FullName) }
  $childAcl.SetAccessRuleProtection($false, $false)
  foreach ($rule in @($childAcl.Access)) {
    if (-not $rule.IsInherited) { $childAcl.RemoveAccessRuleSpecific($rule) }
  }
  if ($_.PSIsContainer) { [System.IO.Directory]::SetAccessControl($_.FullName, $childAcl) }
  else { [System.IO.File]::SetAccessControl($_.FullName, $childAcl) }
}
