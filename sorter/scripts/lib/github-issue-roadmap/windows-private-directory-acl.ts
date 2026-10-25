import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

import type {
  ShadowPrivateDirectoryPolicy,
  WindowsPrivateDirectoryAclController,
  WindowsPrivateDirectoryAclProof,
} from "../../github-issue-roadmap-shadow-validate";

export interface WindowsAclCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export type WindowsAclCommandRunner = (command: WindowsAclCommand) => string;

const WINDOWS_ACL_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$acl = [System.IO.Directory]::GetAccessControl($env:WORKFLOW_TOOLS_ROADMAP_SHADOW_ACL_PATH)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.Access | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    accessControlType = $_.AccessControlType.ToString()
    rights = [int]$_.FileSystemRights
    inheritanceFlags = $_.InheritanceFlags.ToString()
    propagationFlags = $_.PropagationFlags.ToString()
  }
})
[ordered]@{ daclProtected = $acl.AreAccessRulesProtected; ownerSid = $owner; currentSid = $current; rules = $rules } |
  ConvertTo-Json -Compress -Depth 4
`;

const WINDOWS_ACL_SECURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:WORKFLOW_TOOLS_ROADMAP_SHADOW_ACL_PATH
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
@($current.Value, 'S-1-5-18', 'S-1-5-32-544') | ForEach-Object {
  $sid = New-Object System.Security.Principal.SecurityIdentifier($_)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
[void][System.IO.Directory]::CreateDirectory($path, $acl)
[System.IO.Directory]::SetAccessControl($path, $acl)
`;

function windowsAclEnvironment(path: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: source.NODE_ENV === "test" ? "test" : "production",
    WORKFLOW_TOOLS_ROADMAP_SHADOW_ACL_PATH: path,
  };
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "ComSpec", "PROCESSOR_ARCHITECTURE"] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function createWindowsPrivateDirectoryAclController(
  environment: NodeJS.ProcessEnv,
  run: WindowsAclCommandRunner = ({ executable, args, environment: commandEnvironment }) => execFileSync(
    executable,
    [...args],
    { encoding: "utf8", env: commandEnvironment, windowsHide: true, timeout: 30_000 },
  ),
): WindowsPrivateDirectoryAclController {
  const root = environment.SystemRoot ?? environment.WINDIR;
  if (root === undefined || !/^[A-Za-z]:[\\/]/.test(root)) {
    throw new Error("Windows ACL PowerShell requires SystemRoot or WINDIR to be an absolute drive path");
  }
  const executable = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const invokePowerShell = (script: string, path: string): string => run({
    executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    environment: windowsAclEnvironment(path, environment),
  });
  return {
    secure(path): void {
      invokePowerShell(WINDOWS_ACL_SECURE_SCRIPT, path);
    },
    inspect(path): WindowsPrivateDirectoryAclProof {
      return JSON.parse(invokePowerShell(WINDOWS_ACL_INSPECTION_SCRIPT, path)) as WindowsPrivateDirectoryAclProof;
    },
  };
}

export function createShadowPrivateDirectoryPolicy(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
  run?: WindowsAclCommandRunner,
): ShadowPrivateDirectoryPolicy {
  return platform === "win32"
    ? { platform, windowsAcl: createWindowsPrivateDirectoryAclController(environment, run) }
    : { platform };
}
