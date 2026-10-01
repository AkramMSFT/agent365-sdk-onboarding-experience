<#
.SYNOPSIS
    Builds the distributable Agent 365 Onboarding Kit from upstream microsoft/agent365-skills.

.DESCRIPTION
    Turns Microsoft's agent365-skills plugin into a drop-in folder that works with any
    agentic CLI, with no plugin install and no marketplace step.

    What it produces in -OutDir:

        .a365-kit/                  canonical content: skills, shared docs, hook validators
        .claude/skills/             discovery copy for Claude Code
        .agents/skills/             discovery copy for VS Code agent mode / gh skill
        agent365-kit.ps1|.sh        prereq check + per-CLI activation steps
        AGENT365-KIT-README.md      what to do after extracting

    The upstream skills reference sibling files through ${CLAUDE_PLUGIN_ROOT}, which only
    resolves when the skills are loaded as a plugin. Because .a365-kit/ mirrors the upstream
    layout exactly (skills/, shared/, hooks/), rewriting that token to the relative path
    ".a365-kit" fixes every in-body reference in one substitution. Hook commands are the
    exception. Claude Code executes them, so they use ${CLAUDE_PROJECT_DIR}, which it
    expands reliably, quoted to survive spaces in the path.

.PARAMETER UpstreamPath
    Path to an existing git clone of microsoft/agent365-skills. If omitted, the script
    clones upstream into a temp folder and removes it afterwards.

.PARAMETER UpstreamRef
    Branch, tag or commit to build when -UpstreamPath is not supplied. Default: main.
    A branch or tag is shallow-cloned; a commit (7 to 40 hex characters) is checked out
    from a full clone.

.PARAMETER OutDir
    Output directory. Default: <repo>/kit. BUNDLE-MANIFEST.json and SHA256SUMS.txt are
    written at the repo root only when the output is <repo>/kit.

.PARAMETER Zip
    Also produce agent365-onboarding-kit-v<version>.zip (kit only) at the repo root and,
    when the output is <repo>/kit, agent365-onboarding-bundle-v<version>.zip (kit,
    examples, tools and docs).

.PARAMETER KitVersion
    Version stamp for this kit, as MAJOR.MINOR.PATCH. Default: read from build/kit.version.

.PARAMETER BuiltUtc
    Timestamp written to KIT-VERSION.json. Default: now. CI passes the committed value so a
    rebuild of the pinned upstream commit can be compared byte for byte with kit/.

.PARAMETER UpdateSource
    Where the launchers' -Update / --update fetch the kit from, baked into KIT-VERSION.json as
    the build default. Override it when you host the kit yourself: an internal GitHub, an
    artifact server, or a file share (a path works as well as a URL). Users can still override
    per project with `agent365-kit.ps1 -SetUpdateSource`, per shell with A365_KIT_UPDATE_SOURCE,
    or per call with -UpdateFrom.

.EXAMPLE
    .\build\Build-Kit.ps1 -UpstreamPath C:\src\agent365-skills

.EXAMPLE
    .\build\Build-Kit.ps1 -Zip
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
    [string] $UpstreamPath,
    [string] $UpstreamRef = 'main',
    [string] $OutDir,
    [switch] $Zip,
    [string] $KitVersion,
    [string] $BuiltUtc,
    [string] $UpdateSource = 'https://github.com/AkramMSFT/agent365-sdk-onboarding-experience/releases/latest/download/agent365-onboarding-kit-latest.zip'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PayloadDir  = Join-Path $RepoRoot 'payload'
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'kit' }

$KIT_DIR = '.a365-kit'   # Canonical folder name inside the user's project.

function Step { param([string] $T) Write-Host ''; Write-Host "==> $T" -ForegroundColor Cyan }
function Ok   { param([string] $T) Write-Host "    [ok]   $T" -ForegroundColor Green }
function Info { param([string] $T) Write-Host "    $T" -ForegroundColor Gray }
function Warn { param([string] $T) Write-Host "    [warn] $T" -ForegroundColor Yellow }
function Fail { param([string] $T) Write-Host "    [FAIL] $T" -ForegroundColor Red }

if (-not $KitVersion) {
    $versionFile = Join-Path $RepoRoot 'build\kit.version'
    if (-not (Test-Path -LiteralPath $versionFile)) { throw 'build/kit.version not found; the kit version must be explicit.' }
    $KitVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
}
if ($KitVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Kit version '$KitVersion' is not MAJOR.MINOR.PATCH." }
if (-not $BuiltUtc) { $BuiltUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

Write-Host ''
Write-Host 'Agent 365 Onboarding Kit -- build' -ForegroundColor White
Write-Host '=================================' -ForegroundColor DarkGray

Step 'Resolving upstream (microsoft/agent365-skills)'

$TempClone = $null
try {

if ($UpstreamPath) {
    if (-not (Test-Path -LiteralPath $UpstreamPath)) {
        throw "UpstreamPath not found: $UpstreamPath"
    }
    $Upstream = (Resolve-Path -LiteralPath $UpstreamPath).Path
    Ok "Using existing clone: $Upstream"
} else {
    $TempClone = Join-Path ([IO.Path]::GetTempPath()) ("a365-upstream-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    # core.longpaths guards against the Windows MAX_PATH limit, which other Agent 365
    # repositories have hit. autocrlf off keeps upstream's committed line endings, so the
    # output does not depend on the builder's git settings.
    if ($UpstreamRef -match '^[0-9a-f]{7,40}$') {
        Info "Cloning upstream and checking out commit $UpstreamRef into $TempClone"
        & git -c core.longpaths=true clone --quiet --config core.autocrlf=false --config core.eol=lf https://github.com/microsoft/agent365-skills.git $TempClone 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }
        & git -C $TempClone -c advice.detachedHead=false checkout --quiet $UpstreamRef 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "upstream commit $UpstreamRef not found" }
    } else {
        Info "Shallow-cloning $UpstreamRef into $TempClone"
        & git -c core.longpaths=true clone --depth 1 --branch $UpstreamRef --config core.autocrlf=false --config core.eol=lf `
            https://github.com/microsoft/agent365-skills.git $TempClone 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }
    }
    $Upstream = $TempClone
    Ok "Cloned $UpstreamRef"
}

$PluginRoot = Join-Path $Upstream 'plugins\agent365'
foreach ($required in @('skills', 'shared', 'hooks', '.claude-plugin\plugin.json')) {
    $p = Join-Path $PluginRoot $required
    if (-not (Test-Path -LiteralPath $p)) {
        throw "Upstream layout unexpected -- missing: plugins/agent365/$required"
    }
}

$UpstreamVersion = (Get-Content -LiteralPath (Join-Path $PluginRoot '.claude-plugin\plugin.json') -Raw |
    ConvertFrom-Json).version
$UpstreamCommit = (& git -C $Upstream rev-parse --short=7 HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $UpstreamCommit) { throw "Cannot read the upstream commit from $Upstream; it must be a git checkout." }

Ok "upstream agent365-skills v$UpstreamVersion ($UpstreamCommit)"
Ok "building kit v$KitVersion"

Step "Staging canonical content into $KIT_DIR/"

if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$KitPath = Join-Path $OutDir $KIT_DIR
New-Item -ItemType Directory -Force -Path $KitPath | Out-Null

foreach ($dir in @('skills', 'shared', 'hooks')) {
    Copy-Item -LiteralPath (Join-Path $PluginRoot $dir) -Destination $KitPath -Recurse
    Ok "copied $dir/"
}

$TextExtensions = '.md', '.js', '.mjs', '.json', '.sh', '.ps1', '.py', '.ts', '.cs', '.yml', '.yaml', '.txt'

# A Windows checkout of payload/, or of upstream passed in with -UpstreamPath, may have CRLF.
# Normalising to LF keeps the output, and so the manifest hashes, independent of the
# platform that built it.
function Convert-ToLf {
    param([string]$Root, [string]$What)
    $count = 0
    foreach ($path in [IO.Directory]::EnumerateFiles($Root, '*', [IO.SearchOption]::AllDirectories)) {
        if ([IO.Path]::GetExtension($path) -notin $TextExtensions) { continue }
        $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($path))
        if ($text.Contains("`r`n")) {
            [IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
            $count++
        }
    }
    if ($count) { Ok "normalised $count $What file(s) to LF" }
}

Convert-ToLf -Root $KitPath -What 'staged'

# Staged under the kit folder rather than shipped at .github/copilot-instructions.md,
# because that file is often project-owned and an unzip must not overwrite it.
# agent365-kit.ps1 -WireCopilot creates or appends it, so links are relative to .github/.

Step 'Staging GitHub Copilot instructions'

$copilotSrc = Join-Path $Upstream '.github\copilot-instructions.md'
if (-not (Test-Path -LiteralPath $copilotSrc)) { throw 'Upstream .github/copilot-instructions.md not found; fix-ups and the Copilot path need it.' }
$copilot = Get-Content -LiteralPath $copilotSrc -Raw
$copilot = $copilot.Replace('../plugins/agent365/', "../$KIT_DIR/")
$copilot = $copilot.Replace('plugins/agent365/skills/', "$KIT_DIR/skills/")
$copilot = $copilot.Replace('plugins/agent365/shared/', "$KIT_DIR/shared/")
Set-Content -LiteralPath (Join-Path $KitPath 'copilot-instructions.md') -Value $copilot -NoNewline -Encoding UTF8
Ok 'copilot-instructions.md staged (links repointed)'

Step 'Rewriting ${CLAUDE_PLUGIN_ROOT} references'

$skillFiles = Get-ChildItem -Path (Join-Path $KitPath 'skills') -Filter 'SKILL.md' -Recurse
$rewritten = 0

foreach ($file in $skillFiles) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    $before = $text

    # Hook commands are run by the host and need an absolute path. Claude Code expands
    # ${CLAUDE_PROJECT_DIR}; the quotes survive spaces in the path.
    $text = [regex]::Replace(
        $text,
        'command:\s*node\s+\$\{CLAUDE_PLUGIN_ROOT\}/(?<rest>[^\r\n]+?)(?=\s*$)',
        { param($m) 'command: node "${CLAUDE_PROJECT_DIR}/' + $KIT_DIR + '/' + $m.Groups['rest'].Value.Trim() + '"' },
        [Text.RegularExpressions.RegexOptions]::Multiline
    )

    # Everything else is prose resolved with Read/Grep, where a project-relative path
    # works without variable expansion.
    $text = $text.Replace('${CLAUDE_PLUGIN_ROOT}', $KIT_DIR)

    if ($text -ne $before) {
        Set-Content -LiteralPath $file.FullName -Value $text -NoNewline -Encoding UTF8
        $rewritten++
    }
}
Ok "rewrote $rewritten of $($skillFiles.Count) SKILL.md files"

# Plugin command namespace. Upstream refers to skills as /agent365:<name>, which exists
# only when the plugin is installed; project skills are invoked as /<name>. Reference
# docs and validator messages are rewritten too, because the validators print them.

$nsFiles = Get-ChildItem -Path $KitPath -Recurse -File -Include '*.md', '*.js'
$nsRewritten = 0
$nsCount = 0
foreach ($file in $nsFiles) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    $matches = [regex]::Matches($text, '/agent365:(?=[a-z])')
    if ($matches.Count -eq 0) { continue }
    $nsCount += $matches.Count
    Set-Content -LiteralPath $file.FullName -Value ($text -replace '/agent365:(?=[a-z])', '/') -NoNewline -Encoding UTF8
    $nsRewritten++
}
Ok "rewrote $nsCount /agent365: command references across $nsRewritten files"

# Every change to upstream's text is data with an id and an exact match count, so an
# upstream rewording fails the build instead of shipping a half-patched file. Entries for
# one file apply in the order listed, and some target the Copilot file staged above.

Step 'Applying upstream fix-ups'

$fixupFile = Join-Path (Join-Path $RepoRoot 'build') 'upstream-fixups.json'
if (-not (Test-Path -LiteralPath $fixupFile)) { throw 'build/upstream-fixups.json not found.' }
$jsonFixups = @(Get-Content -LiteralPath $fixupFile -Raw -Encoding UTF8 | ConvertFrom-Json)
foreach ($group in $jsonFixups | Group-Object path -CaseSensitive) {
    $target = Join-Path $KitPath $group.Name
    if (-not (Test-Path -LiteralPath $target)) { throw "Fix-up target missing: $($group.Group[0].id) -> $($group.Name)" }
    $content = [IO.File]::ReadAllText($target).Replace("`r`n", "`n")
    foreach ($fx in $group.Group) {
        $find  = $fx.find.Replace("`r`n", "`n")
        $count = [regex]::Matches($content, [regex]::Escape($find)).Count
        if ($count -ne [int]$fx.expectedCount) {
            throw "Fix-up '$($fx.id)' matched $count time(s) in $($fx.path); expected $($fx.expectedCount). Upstream changed -- update build/upstream-fixups.json."
        }
        $content = $content.Replace($find, $fx.replace.Replace("`r`n", "`n"))
    }
    [IO.File]::WriteAllText($target, $content, [Text.UTF8Encoding]::new($false))
}
Ok "$($jsonFixups.Count) upstream fix-ups applied from upstream-fixups.json"

Step 'Adding kit payload'

Copy-Item -Path (Join-Path $PayloadDir '.a365-kit\*') -Destination $KitPath -Recurse -Force
Copy-Item -Path (Join-Path $PayloadDir 'agent365-kit.ps1') -Destination $OutDir -Force
Copy-Item -Path (Join-Path $PayloadDir 'agent365-kit.sh')  -Destination $OutDir -Force

Copy-Item -Path (Join-Path $PayloadDir 'AGENT365-KIT-README.md') -Destination $OutDir -Force
Ok 'add-ons, runtime scripts, launchers, AGENT365-KIT-README.md'

# Ordinal order, so the lists and everything built from them do not depend on the file
# system or the culture of the machine that builds.
function Get-DirNames([string] $Path) {
    $names = [string[]]@(Get-ChildItem -LiteralPath $Path -Directory | ForEach-Object Name)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    return , $names
}
$skillNames = Get-DirNames (Join-Path $KitPath 'skills')
$addonNames = Get-DirNames (Join-Path $KitPath 'addons')

# The kit redistributes Microsoft's MIT-licensed skills, so both licences and the notice
# ship inside .a365-kit/, not the project root where they would collide with the user's
# own LICENSE. The launchers replace .a365-kit/ whole on update.
function Write-Lf([string] $Path, [string] $Text) {
    [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}
$upstreamLicense = Join-Path $Upstream 'LICENSE'
if (-not (Test-Path -LiteralPath $upstreamLicense)) { throw 'Upstream LICENSE not found; the kit cannot be redistributed without it.' }
Write-Lf (Join-Path $KitPath 'LICENSE-agent365-skills') ([IO.File]::ReadAllText($upstreamLicense))
Write-Lf (Join-Path $KitPath 'LICENSE') ([IO.File]::ReadAllText((Join-Path $RepoRoot 'LICENSE')))
$repoUrl = 'https://github.com/AkramMSFT/agent365-sdk-onboarding-experience/blob/main/'
$notice = [IO.File]::ReadAllText((Join-Path $RepoRoot 'NOTICE.md'))
$notice = [regex]::Replace($notice, '\]\((?!https?://|#|mailto:)([^)\s]+)\)', { param($m) "]($repoUrl$($m.Groups[1].Value))" })
Write-Lf (Join-Path $KitPath 'NOTICE.md') $notice
Ok 'LICENSE, LICENSE-agent365-skills, NOTICE.md'

# GitHub Copilot reads only .github/copilot-instructions.md, never SKILL.md discovery
# folders, so the add-ons are listed there too. Links are relative to .github/.
function Get-SkillFrontMatter([string] $Path) {
    $lines = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Split("`n")
    if ($lines[0] -ne '---') { throw "No front matter: $Path" }
    $fm = @{}; $key = $null
    for ($i = 1; $i -lt $lines.Count -and $lines[$i] -ne '---'; $i++) {
        $line = $lines[$i]
        if ($line -match '^([A-Za-z_-]+):\s*(.*)$') {
            $key = $Matches[1]; $val = $Matches[2].Trim()
            $fm[$key] = if ($val -in @('>', '|', '>-', '|-')) { '' } else { $val.Trim('"', "'") }
        } elseif ($key -and $line -match '^\s+(\S.*)$') {
            $fm[$key] = ($fm[$key] + ' ' + $Matches[1].Trim()).Trim()
        }
    }
    return $fm
}
$copilotPath = Join-Path $KitPath 'copilot-instructions.md'
$sb = [Text.StringBuilder]::new()
[void]$sb.Append("`n---`n`n## Kit add-ons`n`n")
[void]$sb.Append("These skills ship with the Agent 365 Onboarding Kit, not with Microsoft's skills. When a request matches one of them, follow its SKILL.md exactly.`n")
foreach ($name in $addonNames) {
    $fm = Get-SkillFrontMatter (Join-Path $KitPath "addons\$name\SKILL.md")
    if ($fm['name'] -ne $name -or -not $fm['description']) { throw "Add-on front matter incomplete: $name" }
    [void]$sb.Append("`n## Add-on: $name`n`n")
    [void]$sb.Append("**Full instructions:** [$KIT_DIR/addons/$name/SKILL.md](../$KIT_DIR/addons/$name/SKILL.md)`n`n")
    [void]$sb.Append("$($fm['description'])`n")
}
$copilotText = [IO.File]::ReadAllText($copilotPath).Replace("`r`n", "`n").TrimEnd() + "`n" + $sb.ToString()
Write-Lf $copilotPath $copilotText
Ok 'copilot-instructions.md lists the kit add-ons'

$manifest = [ordered]@{
    kitVersion      = $KitVersion
    upstreamRepo    = 'microsoft/agent365-skills'
    upstreamVersion = $UpstreamVersion
    upstreamCommit  = $UpstreamCommit
    builtUtc        = $BuiltUtc
    updateSource    = $UpdateSource
    skills          = $skillNames
    addons          = $addonNames
}
$manifest | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $KitPath 'KIT-VERSION.json') -Encoding UTF8
Ok 'KIT-VERSION.json'

Convert-ToLf -Root $OutDir -What 'payload'

# Each CLI family looks in a different place. The skill files are byte-identical
# in all three locations because every internal reference points at .a365-kit/.

Step 'Creating per-CLI discovery copies'

$discoveryTargets = @(
    @{ Path = '.claude\skills'; For = 'Claude Code' }
    @{ Path = '.agents\skills'; For = 'VS Code agent mode / gh skill' }
)

foreach ($target in $discoveryTargets) {
    $dest = Join-Path $OutDir $target.Path
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path (Join-Path $KitPath 'skills\*') -Destination $dest -Recurse -Force
    # Add-ons live in .a365-kit/addons/, apart from the upstream skills so provenance
    # stays clear, but are discovered the same way.
    Copy-Item -Path (Join-Path $KitPath 'addons\*') -Destination $dest -Recurse -Force
    Ok "$($target.Path)  ->  $($target.For)"
}
Ok "add-ons included: $($addonNames -join ', ')"

Step 'Verifying build'

$problems = @()
$outFiles = @([IO.Directory]::EnumerateFiles($OutDir, '*', [IO.SearchOption]::AllDirectories))
$kitFiles = @($outFiles | Where-Object { $_.StartsWith($KitPath + [IO.Path]::DirectorySeparatorChar) })
function Select-Ext([string[]] $Files, [string[]] $Extensions) { @($Files | Where-Object { [IO.Path]::GetExtension($_) -in $Extensions }) }

# Only the ${CLAUDE_PLUGIN_ROOT} token is an error, because it resolves to nothing in a
# drop-in install. path-guard.js reads process.env.CLAUDE_PLUGIN_ROOT deliberately, and
# NOTICE.md quotes both forms to document the rewrite.
$noticeCopy = Join-Path $KitPath 'NOTICE.md'
$leftovers = Select-String -LiteralPath (Select-Ext $outFiles '.md', '.js', '.json' | Where-Object { $_ -ne $noticeCopy }) -Pattern '${CLAUDE_PLUGIN_ROOT}' -SimpleMatch
if ($leftovers) {
    foreach ($hit in $leftovers) {
        $problems += "leftover `${CLAUDE_PLUGIN_ROOT} token: $($hit.Path):$($hit.LineNumber)"
    }
} else {
    Ok 'no ${CLAUDE_PLUGIN_ROOT} path tokens remain'
}

$nsLeft = Select-String -LiteralPath (Select-Ext $outFiles '.md', '.js' | Where-Object { $_ -ne $noticeCopy }) -Pattern '/agent365:' -SimpleMatch
if ($nsLeft) {
    foreach ($hit in $nsLeft) { $problems += "leftover /agent365: namespace: $($hit.Path):$($hit.LineNumber)" }
} else {
    Ok 'no /agent365: plugin command references remain'
}

$refPattern = [regex]::Escape($KIT_DIR) + '/[A-Za-z0-9_./-]+'
$checked = 0
$badRefs = @()
foreach ($file in ('skills', 'addons' | ForEach-Object { Get-ChildItem -Path (Join-Path $KitPath $_) -Filter 'SKILL.md' -Recurse })) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($m in [regex]::Matches($text, $refPattern)) {
        $rel = $m.Value.TrimEnd('.', ',', ')', '`')
        # Directory mentions in prose are not checked.
        if ($rel -notmatch '\.(md|js|mjs|json)$') { continue }
        $checked++
        $abs = Join-Path $OutDir ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $abs)) {
            $badRefs += "$($file.Name) -> $rel"
        }
    }
}
$badRefs = $badRefs | Select-Object -Unique
if ($badRefs) {
    foreach ($b in $badRefs) { $problems += "broken reference: $b" }
} else {
    Ok "all $checked skill file references resolve"
}

$before = $problems.Count
$jsFiles = Select-Ext $kitFiles '.js', '.mjs'
$problems += @($jsFiles | ForEach-Object -ThrottleLimit 8 -Parallel {
    & node --check $_ 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { "JS syntax error: $_" }
} | Sort-Object)
if ($problems.Count -eq $before) { Ok "$($jsFiles.Count) JS/MJS files parse cleanly" }

$before = $problems.Count
$canonicalNames = [string[]]($skillNames + $addonNames)
[Array]::Sort($canonicalNames, [StringComparer]::Ordinal)
foreach ($target in $discoveryTargets) {
    if (Compare-Object $canonicalNames (Get-DirNames (Join-Path $OutDir $target.Path))) {
        $problems += "discovery copy out of sync: $($target.Path)"
    }
}
if ($problems.Count -eq $before) { Ok "discovery copies match canonical skills + add-ons ($($canonicalNames.Count) total)" }

$before = $problems.Count
$hookCmds = Select-String -Path (Join-Path $KitPath 'skills\*\SKILL.md') -Pattern 'command:\s*node'
foreach ($hit in $hookCmds) {
    if ($hit.Line -notmatch '\$\{CLAUDE_PROJECT_DIR\}') {
        $problems += "hook command not repointed: $($hit.Path):$($hit.LineNumber)"
    }
}
if ($problems.Count -eq $before) { Ok "$($hookCmds.Count) hook commands repointed to `${CLAUDE_PROJECT_DIR}" }

# Claims the fix-ups removed must not reappear elsewhere in the shipped guidance.
$before = $problems.Count
$retracted = @(
    @{ Pattern = 'auto-registers `IExporterTokenCache'; Why = '.NET token cache is registered explicitly, not by the distro' },
    @{ Pattern = 'Auto-registered by the Microsoft.OpenTelemetry distro'; Why = '.NET token cache is registered explicitly, not by the distro' },
    @{ Pattern = 'cache is auto-registered by `UseMicrosoftOpenTelemetry'; Why = '.NET token cache is registered explicitly, not by the distro' },
    @{ Pattern = 'RefreshObservabilityToken('; Why = 'the Node.js method is refreshObservabilityToken (camelCase)'; CaseSensitive = $true }
)
$kitMarkdown = Select-Ext $kitFiles '.md'
foreach ($r in $retracted) {
    $hits = Select-String -LiteralPath $kitMarkdown -Pattern $r.Pattern -SimpleMatch -CaseSensitive:([bool]$r['CaseSensitive'])
    foreach ($hit in $hits) { $problems += "retracted claim '$($r.Pattern)' ($($r.Why)): $($hit.Path):$($hit.LineNumber)" }
}
if ($problems.Count -eq $before) { Ok 'no retracted claims remain in shipped guidance' }

$before = $problems.Count
foreach ($f in @('LICENSE', 'LICENSE-agent365-skills', 'NOTICE.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $KitPath $f))) { $problems += "missing $KIT_DIR/$f" }
}
$copilotText = [IO.File]::ReadAllText((Join-Path $KitPath 'copilot-instructions.md'))
foreach ($a in $addonNames) {
    if (-not $copilotText.Contains("## Add-on: $a")) { $problems += "copilot-instructions.md does not list add-on $a" }
}
if ($problems.Count -eq $before) { Ok 'licences present; Copilot instructions list every add-on' }

if ($problems.Count -gt 0) {
    Write-Host ''
    Fail "$($problems.Count) problem(s):"
    $problems | ForEach-Object { Write-Host "           $_" -ForegroundColor Red }
    throw 'Build verification failed.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
# Entries come from an explicit list: Compress-Archive leaves out hidden items, which on
# Linux is every dot-folder the kit is made of.
function New-Zip([string] $ZipPath, [string] $Base, [string[]] $Entries) {
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    $archive = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($rel in $Entries) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $Base $rel), $rel, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
    Ok "$(Split-Path -Leaf $ZipPath) ($([math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1KB)) KB)"
}

if ($Zip) {
    Step 'Packaging'
    $kitEntries = [string[]]@($outFiles | ForEach-Object { [IO.Path]::GetRelativePath($OutDir, $_).Replace('\', '/') })
    [Array]::Sort($kitEntries, [StringComparer]::Ordinal)
    New-Zip (Join-Path $RepoRoot "agent365-onboarding-kit-v$KitVersion.zip") $OutDir $kitEntries
}

# tools/prepare-workspace.mjs copies kit/** and examples/<id>/** as listed in
# BUNDLE-MANIFEST.json, verifying each file's SHA-256. Emitted only when the kit was
# built into the repository, because the manifest describes the repository layout.

if ((Resolve-Path -LiteralPath $OutDir).Path.TrimEnd('\') -eq (Join-Path $RepoRoot 'kit')) {
    Step 'Writing BUNDLE-MANIFEST.json and SHA256SUMS.txt'
    $manifestFiles = @()
    $sumLines = @()
    $roots = @('kit', 'examples', 'tools', 'docs', 'README.md', 'GUIDE.md', 'NOTICE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', '.gitattributes')
    # Only files git would publish, tracked or new but never ignored, so a maintainer's
    # .env, a365 config or build output inside examples/ never reaches a release.
    foreach ($root in $roots) {
        $listed = (& git -C $RepoRoot -c core.quotepath=off ls-files --cached --others --exclude-standard -z -- $root) -split "`0"
        if ($LASTEXITCODE -ne 0) { throw "git ls-files failed for $root" }
        foreach ($rel in ($listed | Where-Object { $_ } | Sort-Object -Unique -CaseSensitive -Culture '')) {
            $abs = Join-Path $RepoRoot $rel
            if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
            $f = Get-Item -LiteralPath $abs -Force
            $hash = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLower()
            $manifestFiles += [ordered]@{ path = $rel; bytes = $f.Length; sha256 = $hash }
            $sumLines += "$hash  $rel"
        }
    }
    $catalog = Join-Path (Join-Path $RepoRoot 'build') 'bundle-examples.json'
    $examples = @(Get-Content -LiteralPath $catalog -Raw -Encoding UTF8 | ConvertFrom-Json)
    $manifest = [ordered]@{
        schemaVersion   = 1
        bundleVersion   = $KitVersion
        kitVersion      = $KitVersion
        upstreamRepo    = 'microsoft/agent365-skills'
        upstreamVersion = $UpstreamVersion
        upstreamCommit  = $UpstreamCommit
        examples        = $examples
        files           = $manifestFiles
    }
    (($manifest | ConvertTo-Json -Depth 6) -replace "`r`n", "`n") + "`n" | Set-Content -LiteralPath (Join-Path $RepoRoot 'BUNDLE-MANIFEST.json') -NoNewline -Encoding UTF8
    (($sumLines -join "`n") + "`n") | Set-Content -LiteralPath (Join-Path $RepoRoot 'SHA256SUMS.txt') -NoNewline -Encoding UTF8
    Ok "manifest lists $($manifestFiles.Count) files, $($examples.Count) examples"

    if ($Zip) {
        $bundleRel = @($manifestFiles | ForEach-Object { $_.path }) + @('BUNDLE-MANIFEST.json', 'SHA256SUMS.txt')
        New-Zip (Join-Path $RepoRoot "agent365-onboarding-bundle-v$KitVersion.zip") $RepoRoot $bundleRel
    }
}

Write-Host ''
Write-Host 'Build succeeded.' -ForegroundColor Green
Info "kit v$KitVersion  |  upstream agent365-skills v$UpstreamVersion ($UpstreamCommit)"
Info "output: $OutDir"
Write-Host ''

}
finally {
    if ($TempClone -and (Test-Path -LiteralPath $TempClone)) {
        Remove-Item -LiteralPath $TempClone -Recurse -Force -ErrorAction SilentlyContinue
    }
}
