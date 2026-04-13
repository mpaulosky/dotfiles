#!/usr/bin/env pwsh
# Copyright (c) Matthew Paulosky. All rights reserved.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Scaffolds a new Blazor project folder from the BaseNewProjectFiles template.

.DESCRIPTION
    Automates Phase 0 of the Blazor Web App Starter Template PRD:
    1. Creates the project folder under the specified parent directory
    2. Initializes a Git repository
    3. Copies all contents (including hidden files) from BaseNewProjectFiles/
    4. Creates a GitHub remote repository and pushes the initial commit
    5. Initializes Squad
    6. Launches GitHub Copilot with Squad agent

.PARAMETER ProjectName
    The name of the new project folder to create.

.PARAMETER ParentDirectory
    The parent directory where the project folder will be created. Defaults to ~/Repos.

.PARAMETER SkipCopilotLaunch
    If set, skips launching GitHub Copilot after setup.

.EXAMPLE
    ./New-ProjectFromTemplate.ps1 -ProjectName MyBlazorApp

.EXAMPLE
    ./New-ProjectFromTemplate.ps1 -ProjectName MyBlazorApp -ParentDirectory ~/Projects

.EXAMPLE
    ./New-ProjectFromTemplate.ps1 -ProjectName MyBlazorApp -SkipCopilotLaunch
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectName,

    [Parameter(Position = 1)]
    [string]$ParentDirectory = "~/Repos",

    [switch]$SkipCopilotLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Preflight validation (all checks before any filesystem changes) ---

# Validate ProjectName contains only safe characters
if ($ProjectName -notmatch '^[A-Za-z0-9._-]+$') {
    Write-Error "ProjectName '$ProjectName' contains invalid characters. Use only letters, digits, dots, hyphens, and underscores."
    return
}

# Resolve paths
$ParentDirectory = (Resolve-Path -Path $ParentDirectory).Path
$projectPath = Join-Path -Path $ParentDirectory -ChildPath $ProjectName
$templatePath = Join-Path -Path $PSScriptRoot -ChildPath "BaseNewProjectFiles"

# Validate template folder exists
if (-not (Test-Path -Path $templatePath)) {
    Write-Error "Template folder not found: $templatePath"
    return
}

# Check if project folder already exists
if (Test-Path -Path $projectPath) {
    Write-Error "Project folder already exists: $projectPath. Aborting to avoid overwriting."
    return
}

# Validate git is available
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not installed or not on PATH. Install Git and try again."
    return
}

# Validate copilot is available (unless skipping launch)
if (-not $SkipCopilotLaunch -and -not (Get-Command copilot -ErrorAction SilentlyContinue)) {
    Write-Error "GitHub Copilot CLI is not installed or not on PATH. Install it or use -SkipCopilotLaunch."
    return
}

# Validate gh CLI is available (for GitHub repo creation)
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "GitHub CLI (gh) is not installed or not on PATH. Install it: https://cli.github.com/"
    return
}

Write-Host ""
Write-Host "=== New Project from Template ===" -ForegroundColor Cyan
Write-Host "  Project Name : $ProjectName" -ForegroundColor White
Write-Host "  Location     : $projectPath" -ForegroundColor White
Write-Host "  Template     : $templatePath" -ForegroundColor White
Write-Host ""

# Step 1: Create project folder
if ($PSCmdlet.ShouldProcess($projectPath, "Create project folder")) {
    Write-Host "[1/6] Creating project folder..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $projectPath -Force | Out-Null
    Write-Host "       Created: $projectPath" -ForegroundColor Green
}

# Step 2: Initialize Git repository
if ($PSCmdlet.ShouldProcess($projectPath, "Initialize Git repository")) {
    Write-Host "[2/6] Initializing Git repository..." -ForegroundColor Yellow
    Push-Location -Path $projectPath
    try {
        git init -b main 2>&1 | Out-Null
        Write-Host "       Git initialized." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# Step 3: Copy all contents from BaseNewProjectFiles (including hidden files)
if ($PSCmdlet.ShouldProcess($projectPath, "Copy template contents")) {
    Write-Host "[3/6] Copying template contents (including hidden files)..." -ForegroundColor Yellow

    # Get-ChildItem -Force includes hidden items; copy each top-level item
    Get-ChildItem -Path $templatePath -Force | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $projectPath -Recurse -Force
    }

    $itemCount = (Get-ChildItem -Path $projectPath -Force | Measure-Object).Count
    Write-Host "       Copied $itemCount items to project folder." -ForegroundColor Green
}

# Step 4: Create GitHub remote repository and push initial commit
if ($PSCmdlet.ShouldProcess($projectPath, "Create GitHub repo and push initial commit")) {
    Write-Host "[4/6] Creating GitHub repository and pushing initial commit..." -ForegroundColor Yellow
    Push-Location -Path $projectPath
    try {
        git add . 2>&1 | Out-Null
        git commit -m "Initial commit from Blazor template" 2>&1 | Out-Null
        gh repo create $ProjectName --public --source . --push 2>&1 | Out-Null
        Write-Host "       GitHub repo created and initial commit pushed." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# Step 5: Initialize Squad
if ($PSCmdlet.ShouldProcess($projectPath, "Initialize Squad")) {
    Write-Host "[5/6] Initializing Squad..." -ForegroundColor Yellow
    Set-Location -Path $projectPath
    squad init
    Write-Host "       Squad initialized." -ForegroundColor Green
}

# Step 6: Launch Copilot
if (-not $SkipCopilotLaunch) {
    Write-Host "[6/6] Launching GitHub Copilot with Squad agent..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
    Write-Host "  Provide the PRD as context and instruct Copilot to begin Phase 1." -ForegroundColor White
    Write-Host ""

    Set-Location -Path $projectPath
    copilot --agent squad --yolo --experimental
} else {
    Write-Host "[6/6] Skipping Copilot launch (use -SkipCopilotLaunch to control this)." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
    Write-Host "  To continue manually:" -ForegroundColor White
    Write-Host "    cd $projectPath" -ForegroundColor White
    Write-Host "    copilot --agent squad --yolo --experimental" -ForegroundColor White
    Write-Host ""
}
