<#
.SYNOPSIS
    Production-ready Windows Launcher for Telegram Clipper in Local Mode.
    Orchestrates telegram-bot-api.exe and the Node bot with health checks,
    prefixed stdout/stderr logging, and clean process tree termination on shutdown.
#>

$ErrorActionPreference = "Stop"

# 1. Resolve Project Root and Paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Get-Item (Split-Path -Parent $ScriptDir)).FullName
Set-Location $ProjectRoot

$EnvFile = Join-Path $ProjectRoot ".env"
$ApiExe = Join-Path $ProjectRoot "tools\telegram-bot-api\telegram-bot-api.exe"
$WorkingDir = Join-Path $ProjectRoot "temp\telegram-bot-api"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " TELEGRAM CLIPPER LOCAL MODE LAUNCHER" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Verify Executable Exists
if (-not (Test-Path $ApiExe)) {
    Write-Error "[LOCAL API] Executable not found at $ApiExe. Please ensure tools\telegram-bot-api\telegram-bot-api.exe exists."
    exit 1
}

# 2. Parse .env (Safe without printing secrets)
$EnvVars = @{}
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $parts = $line -split '=', 2
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                $EnvVars[$key] = $val
            }
        }
    }
} else {
    Write-Error "[ENV] .env file not found at $EnvFile."
    exit 1
}

$ApiId = $EnvVars['TELEGRAM_API_ID']
$ApiHash = $EnvVars['TELEGRAM_API_HASH']

# 3. Process Duplicate Protection
# Check if an instance of the Node bot is already running
$RunningNodeBots = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq "node.exe" -and ($_.CommandLine -like "*src/index.js*" -or $_.CommandLine -like "*src\index.js*")
}
if ($RunningNodeBots) {
    foreach ($nb in $RunningNodeBots) {
        Write-Host "[BOT] An instance of Telegram Clipper Node bot is already running (PID $($nb.ProcessId)). Please stop it before launching." -ForegroundColor Red
    }
    exit 1
}

# TCP Port Availability Checker
function Test-PortOpen {
    param(
        [string]$HostName = "127.0.0.1",
        [int]$Port = 8081,
        [int]$TimeoutMs = 400
    )
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        $success = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $success) {
            $client.Close()
            return $false
        }
        $client.EndConnect($iar)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

# Helper to cleanly kill process trees
function Stop-ProcessTree {
    param([int]$ProcessId)
    if ($ProcessId -gt 0) {
        try {
            $null = & taskkill.exe /PID $ProcessId /T /F 2>&1
        } catch {}
    }
}

# Check if Port 8081 is already in use
$IsReusedApi = $false
$ApiProc = $null
$BotProc = $null

$PortOccupied = Test-PortOpen -HostName "127.0.0.1" -Port 8081 -TimeoutMs 500
if ($PortOccupied) {
    $NetConn = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($NetConn) {
        $OwnerProc = Get-Process -Id $NetConn.OwningProcess -ErrorAction SilentlyContinue
        if ($OwnerProc -and ($OwnerProc.ProcessName -like "*telegram-bot-api*")) {
            Write-Host "[LOCAL API] Reusing existing telegram-bot-api instance on port 8081" -ForegroundColor Yellow
            $ApiProc = $OwnerProc
            $IsReusedApi = $true
        } else {
            Write-Host "[LOCAL API] Port 8081 is occupied by an unrelated process: $($OwnerProc.ProcessName) (PID $($OwnerProc.Id)). Please terminate it first." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "[LOCAL API] Reusing existing telegram-bot-api instance on port 8081" -ForegroundColor Yellow
        $IsReusedApi = $true
    }
}

# 4. Start Local Bot API (if not already running)
if (-not $IsReusedApi) {
    if (-not (Test-Path $WorkingDir)) {
        New-Item -ItemType Directory -Path $WorkingDir -Force | Out-Null
    }

    Write-Host "[LOCAL API] Starting..." -ForegroundColor Cyan

    $ApiStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $ApiStartInfo.FileName = $ApiExe
    $ApiStartInfo.Arguments = "--local --http-port=8081 --dir=`"$WorkingDir`""
    if ($ApiId -and $ApiHash) {
        $ApiStartInfo.Arguments += " --api-id=$ApiId --api-hash=$ApiHash"
    }
    $ApiStartInfo.WorkingDirectory = (Split-Path $ApiExe)
    $ApiStartInfo.RedirectStandardOutput = $true
    $ApiStartInfo.RedirectStandardError = $true
    $ApiStartInfo.UseShellExecute = $false
    $ApiStartInfo.CreateNoWindow = $true

    $ApiProc = New-Object System.Diagnostics.Process
    $ApiProc.StartInfo = $ApiStartInfo

    Register-ObjectEvent -InputObject $ApiProc -EventName "OutputDataReceived" -Action {
        if (-not [string]::IsNullOrWhiteSpace($EventArgs.Data)) {
            [Console]::WriteLine("[LOCAL API] " + $EventArgs.Data)
        }
    } | Out-Null

    Register-ObjectEvent -InputObject $ApiProc -EventName "ErrorDataReceived" -Action {
        if (-not [string]::IsNullOrWhiteSpace($EventArgs.Data)) {
            [Console]::WriteLine("[LOCAL API] " + $EventArgs.Data)
        }
    } | Out-Null

    try {
        $ApiProc.Start() | Out-Null
        $ApiProc.BeginOutputReadLine()
        $ApiProc.BeginErrorReadLine()
    } catch {
        Write-Host "[LOCAL API] Failed to start telegram-bot-api.exe: $_" -ForegroundColor Red
        exit 1
    }
}

# 5. Health Check: Wait for Port 8081 (Timeout: 30s)
if (-not $IsReusedApi) {
    Write-Host "[LOCAL API] Waiting for port 8081..." -ForegroundColor Cyan
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $PortReady = $false

    while ($Stopwatch.Elapsed.TotalSeconds -lt 30) {
        if ($ApiProc -and -not $IsReusedApi -and $ApiProc.HasExited) {
            $ExitCode = $ApiProc.ExitCode
            Write-Host "[LOCAL API] telegram-bot-api process terminated unexpectedly with exit code $ExitCode." -ForegroundColor Red
            exit 1
        }
        if (Test-PortOpen -HostName "127.0.0.1" -Port 8081 -TimeoutMs 350) {
            $PortReady = $true
            break
        }
        Start-Sleep -Milliseconds 350
    }

    if (-not $PortReady) {
        Write-Host "[LOCAL API] Timeout: Port 8081 did not become ready within 30 seconds." -ForegroundColor Red
        if ($ApiProc -and -not $IsReusedApi -and -not $ApiProc.HasExited) {
            Stop-ProcessTree -ProcessId $ApiProc.Id
        }
        exit 1
    }
}

Write-Host "[LOCAL API] Ready on http://127.0.0.1:8081" -ForegroundColor Green

# 6. Start Node Bot via npm start
Write-Host "[BOT] Starting npm start..." -ForegroundColor Cyan

$BotStartInfo = New-Object System.Diagnostics.ProcessStartInfo
$BotStartInfo.FileName = "cmd.exe"
$BotStartInfo.Arguments = "/c npm start"
$BotStartInfo.WorkingDirectory = $ProjectRoot
$BotStartInfo.RedirectStandardOutput = $true
$BotStartInfo.RedirectStandardError = $true
$BotStartInfo.UseShellExecute = $false
$BotStartInfo.CreateNoWindow = $true

$BotProc = New-Object System.Diagnostics.Process
$BotProc.StartInfo = $BotStartInfo

Register-ObjectEvent -InputObject $BotProc -EventName "OutputDataReceived" -Action {
    if (-not [string]::IsNullOrWhiteSpace($EventArgs.Data)) {
        [Console]::WriteLine("[BOT] " + $EventArgs.Data)
    }
} | Out-Null

Register-ObjectEvent -InputObject $BotProc -EventName "ErrorDataReceived" -Action {
    if (-not [string]::IsNullOrWhiteSpace($EventArgs.Data)) {
        [Console]::WriteLine("[BOT] " + $EventArgs.Data)
    }
} | Out-Null

try {
    $BotProc.Start() | Out-Null
    $BotProc.BeginOutputReadLine()
    $BotProc.BeginErrorReadLine()
} catch {
    Write-Host "[BOT] Failed to start Node bot: $_" -ForegroundColor Red
    if ($ApiProc -and -not $IsReusedApi -and -not $ApiProc.HasExited) {
        Stop-ProcessTree -ProcessId $ApiProc.Id
    }
    exit 1
}

# 7. Clean Shutdown Handler
$script:ShuttingDown = $false

$Cleanup = {
    if ($script:ShuttingDown) { return }
    $script:ShuttingDown = $true

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host " SHUTTING DOWN PROCESSES CLEANLY" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow

    if ($BotProc -and -not $BotProc.HasExited) {
        Write-Host "[SHUTDOWN] Stopping Node bot (PID $($BotProc.Id))..." -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId $BotProc.Id
    }

    if ($ApiProc -and -not $IsReusedApi -and -not $ApiProc.HasExited) {
        Write-Host "[SHUTDOWN] Stopping Local Telegram Bot API (PID $($ApiProc.Id))..." -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId $ApiProc.Id
    }

    Write-Host "[SHUTDOWN] Shutdown complete." -ForegroundColor Green
}

# Intercept Ctrl+C
try {
    [Console]::TreatControlCAsInput = $false
} catch {}

$CancelEvent = {
    param($s, $e)
    $e.Cancel = $true
    & $Cleanup
    [Environment]::Exit(0)
}
[Console]::add_CancelKeyPress($CancelEvent)

# 8. Main Monitoring Loop
try {
    while (-not $script:ShuttingDown) {
        if ($BotProc -and $BotProc.HasExited) {
            Write-Host "[BOT] Node bot process exited with code $($BotProc.ExitCode)." -ForegroundColor Yellow
            break
        }
        if ($ApiProc -and -not $IsReusedApi -and $ApiProc.HasExited) {
            Write-Host "[LOCAL API] Local Telegram Bot API exited with code $($ApiProc.ExitCode)." -ForegroundColor Red
            break
        }
        Start-Sleep -Milliseconds 300
    }
} finally {
    & $Cleanup
}
