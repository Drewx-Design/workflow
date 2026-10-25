$ErrorActionPreference = 'Stop'

# The model process is created suspended, assigned to a kill-on-close Job Object,
# and resumed only after containment succeeds. Its stdio remains connected directly
# to the Node parent, so this helper never reads or rewrites the assessment payload.
$encoded = $env:ROADMAP_STEWARDSHIP_SEAT_LAUNCH
Remove-Item Env:ROADMAP_STEWARDSHIP_SEAT_LAUNCH -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($encoded)) { exit 125 }

try {
  $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$launch.command) -or [string]::IsNullOrWhiteSpace([string]$launch.cwd)) { exit 125 }

  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class StewardshipSeatJob
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xffffffff;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint desiredAccess, bool inheritHandle, uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr InheritableStandardHandle(int kind)
    {
        IntPtr duplicate;
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, GetStdHandle(kind), current, out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return duplicate;
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static StringBuilder CommandLine(string command, string[] arguments)
    {
        var line = new StringBuilder(Quote(command));
        foreach (string argument in arguments) line.Append(' ').Append(Quote(argument ?? String.Empty));
        return line;
    }

    private static void ThrowLastError() { throw new Win32Exception(Marshal.GetLastWin32Error()); }

    private static IntPtr EnvironmentBlock(string[] entries)
    {
        var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var validated = new List<string>();
        foreach (string entry in entries ?? new string[0])
        {
            int separator = entry == null ? -1 : entry.IndexOf('=');
            string name = separator < 0 ? String.Empty : entry.Substring(0, separator);
            if (String.IsNullOrEmpty(name) || name.IndexOf('\0') >= 0 || entry.IndexOf('\0') >= 0 || !unique.Add(name))
                throw new InvalidOperationException("Invalid environment entry");
            validated.Add(entry);
        }
        validated.Sort(StringComparer.OrdinalIgnoreCase);
        return Marshal.StringToHGlobalUni(String.Join("\0", validated.ToArray()) + "\0\0");
    }

    public static int Run(string command, string[] arguments, string workingDirectory, string[] environmentEntries)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr limits = IntPtr.Zero;
        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool resumed = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError();
            var extended = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int extendedSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            limits = Marshal.AllocHGlobal(extendedSize);
            Marshal.StructureToPtr(extended, limits, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, (uint)extendedSize)) ThrowLastError();

            stdin = InheritableStandardHandle(STD_INPUT_HANDLE);
            stdout = InheritableStandardHandle(STD_OUTPUT_HANDLE);
            stderr = InheritableStandardHandle(STD_ERROR_HANDLE);
            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdout;
            startup.hStdError = stderr;
            environment = EnvironmentBlock(environmentEntries);
            if (!CreateProcess(command, CommandLine(command, arguments), IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environment, workingDirectory, ref startup, out process)) ThrowLastError();
            if (!AssignProcessToJobObject(job, process.hProcess)) ThrowLastError();
            if (ResumeThread(process.hThread) == 0xffffffff) ThrowLastError();
            resumed = true;
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            if (WaitForSingleObject(process.hProcess, INFINITE) != 0) ThrowLastError();
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) ThrowLastError();

            if (!TerminateJobObject(job, 1)) ThrowLastError();
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadline)
            {
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
                if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) ThrowLastError();
                // Reserve 125 for this helper's containment/cleanup failure signal.
                if (accounting.ActiveProcesses == 0) return exitCode == 125 ? 124 : unchecked((int)exitCode);
                Thread.Sleep(10);
            }
            throw new InvalidOperationException("Seat Job Object did not drain");
        }
        finally
        {
            if (!resumed && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 125);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (stdin != IntPtr.Zero) CloseHandle(stdin);
            if (stdout != IntPtr.Zero) CloseHandle(stdout);
            if (stderr != IntPtr.Zero) CloseHandle(stderr);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (limits != IntPtr.Zero) Marshal.FreeHGlobal(limits);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

  $arguments = @($launch.args | ForEach-Object { [string]$_ })
  $environmentEntries = @($launch.environment | ForEach-Object {
    if ($_ -isnot [Array] -or $_.Count -ne 2 -or $null -eq $_[0] -or $null -eq $_[1]) { throw 'Invalid seat environment' }
    $name = [string]$_[0]
    if ([string]::IsNullOrEmpty($name) -or $name.Contains('=') -or $name.Contains([char]0)) { throw 'Invalid seat environment' }
    "$name=$([string]$_[1])"
  })
  $exitCode = [StewardshipSeatJob]::Run([string]$launch.command, [string[]]$arguments, [string]$launch.cwd, [string[]]$environmentEntries)
  exit $exitCode
} catch {
  exit 125
}
