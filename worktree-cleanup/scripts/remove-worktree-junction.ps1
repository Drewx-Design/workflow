#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Path,
    [ValidateSet('unlink-junction', 'unlink-self-links')][string]$EventKind = 'unlink-junction',
    [string]$ExpectedLinkType,
    [string]$ExpectedTarget
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrEmpty($ExpectedLinkType) -or [string]::IsNullOrEmpty($ExpectedTarget)) {
    throw 'Expected LinkType and raw target are required for the exact entry.'
}

# Refuse alternate spellings that address a junction's contents or resolve through
# another link. LiteralPath is essential for names containing brackets or quotes.
if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw 'The exact entry must be an absolute junction path.'
}
$fullPath = [System.IO.Path]::GetFullPath($Path)
if ($fullPath -ne $Path.Replace('/', '\') -or $fullPath.EndsWith('\') -or $fullPath.EndsWith('/')) {
    throw 'The exact entry must be a junction, without a trailing separator or relative components.'
}
$parentPath = [System.IO.Path]::GetDirectoryName($fullPath)
while ($parentPath) {
    $parent = Get-Item -LiteralPath $parentPath -Force
    if (-not $parent.PSIsContainer -or ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The exact entry must be a junction with ordinary directory ancestors.'
    }
    $parentPath = [System.IO.Path]::GetDirectoryName($parentPath)
}
function AssertEntryIdentity {
    $entry = Get-Item -LiteralPath $fullPath -Force
    $allowedKind = $entry.LinkType -ceq 'Junction' -or
        ($EventKind -eq 'unlink-self-links' -and $entry.LinkType -ceq 'SymbolicLink')
    if (-not $entry.PSIsContainer -or
        -not ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or -not $allowedKind) {
        throw 'The exact entry must be a directory junction or permitted directory symbolic link; refusing to delete anything else.'
    }
    $targets = @($entry.Target)
    if ($entry.LinkType -cne $ExpectedLinkType -or $targets.Count -ne 1 -or $targets[0] -cne $ExpectedTarget) {
        throw 'The exact entry LinkType or raw target changed; refusing to delete it.'
    }
}
# Bind the caller's exact identity again immediately before the non-recursive unlink.
AssertEntryIdentity
[System.IO.Directory]::Delete($fullPath, $false)
