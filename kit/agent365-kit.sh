#!/usr/bin/env bash
# Agent 365 Onboarding Kit: prerequisite check and per-CLI activation steps.
#
# Run this from the root of your agent project after extracting the kit into it.
# The skills do the onboarding. This script checks that the kit landed correctly,
# verifies prerequisites, detects which agentic CLIs you have, and prints the exact
# steps to load the skills in each one.
#
# Usage:
#   ./agent365-kit.sh                 check prerequisites, print activation steps
#   ./agent365-kit.sh --doctor-only   check prerequisites and stop
#   ./agent365-kit.sh --skip-doctor   skip the prerequisite check
#   ./agent365-kit.sh --wire-copilot  create/append .github/copilot-instructions.md
#   ./agent365-kit.sh --wire-claude-hook  add the optional notice without replacing settings
#   ./agent365-kit.sh --launch claude launch Claude Code with the trigger phrase
#   ./agent365-kit.sh --update        replace the kit with the latest release (kit paths only)
#   ./agent365-kit.sh --update --update-from <zip|url>   update once from a local zip or another URL
#   ./agent365-kit.sh --set-update-source <zip|url>      persist the source for this project
#                                     (a365-kit.config.json; commit it). Empty string clears it.
#   The update source is the first of these that is set: --update-from, $A365_KIT_UPDATE_SOURCE,
#   a365-kit.config.json, the build default in .a365-kit/KIT-VERSION.json, then the public
#   GitHub release. Saved relative paths resolve from the project; one-off and environment
#   paths resolve from the caller's working directory.

set -euo pipefail

TRIGGER='Onboard this agent to Agent 365.'

# A set CDPATH can make cd pick another directory and echo it, corrupting KIT_ROOT.
KIT_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DOCTOR_ONLY=0
SKIP_DOCTOR=0
WIRE_COPILOT=0
WIRE_CLAUDE_HOOK=0
LAUNCH=''
UPDATE=0
UPDATE_FROM=''
SET_UPDATE_SOURCE=''
SET_UPDATE_SOURCE_GIVEN=0
PUBLIC_SOURCE='https://github.com/AkramMSFT/agent365-sdk-onboarding-experience/releases/latest/download/agent365-onboarding-kit-latest.zip'
KIT_CONFIG="$KIT_ROOT/a365-kit.config.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --doctor-only)        DOCTOR_ONLY=1 ;;
    --skip-doctor)        SKIP_DOCTOR=1 ;;
    --wire-copilot)       WIRE_COPILOT=1 ;;
    --wire-claude-hook)   WIRE_CLAUDE_HOOK=1 ;;
    --launch)
      [ $# -ge 2 ] && [ "$2" = 'claude' ] || { echo 'Usage: --launch claude' >&2; exit 2; }
      shift; LAUNCH="$1" ;;
    --update)             UPDATE=1 ;;
    --update-from|--set-update-source)
      OPTION="$1"
      [ $# -ge 2 ] && [[ "$2" != --* ]] || { echo "$OPTION requires a value (use \"\" to clear a saved source)." >&2; exit 2; }
      shift
      if [ "$OPTION" = '--update-from' ]; then UPDATE_FROM="$1"
      else SET_UPDATE_SOURCE="$1"; SET_UPDATE_SOURCE_GIVEN=1; fi ;;
    -h|--help)            sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# a365-kit.config.json sits outside the paths --update replaces, so a team that
# mirrors the kit can set its update source once.
resolve_update_source() {
  local v
  if [ -n "$UPDATE_FROM" ]; then RESOLVED_SOURCE="$UPDATE_FROM"; SOURCE_ORIGIN='--update-from'; return; fi
  if [ -n "${A365_KIT_UPDATE_SOURCE:-}" ]; then RESOLVED_SOURCE="$A365_KIT_UPDATE_SOURCE"; SOURCE_ORIGIN='A365_KIT_UPDATE_SOURCE'; return; fi
  if command -v node >/dev/null 2>&1; then
    set -- "$KIT_CONFIG" 'a365-kit.config.json' "$KIT_ROOT/.a365-kit/KIT-VERSION.json" 'kit build default'
    while [ $# -gt 0 ]; do
      if [ -f "$1" ]; then
        v="$(read_update_source "$1")"
        if [ -n "$v" ]; then RESOLVED_SOURCE="$v"; SOURCE_ORIGIN="$2"; return; fi
      fi
      shift 2
    done
  fi
  RESOLVED_SOURCE="$PUBLIC_SOURCE"; SOURCE_ORIGIN='public GitHub release'
}

read_update_source() {
  node -e '
    try {
      const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,""));
      if(c && typeof c.updateSource==="string" && c.updateSource.trim()) process.stdout.write(c.updateSource);
    } catch {}' "$1"
}

is_http_source() {
  [[ "$1" =~ ^[Hh][Tt][Tt][Pp][Ss]?:// ]]
}

if [ "$SET_UPDATE_SOURCE_GIVEN" -eq 1 ]; then
  command -v node >/dev/null 2>&1 || { echo "  node is required (it is a kit prerequisite)" >&2; exit 1; }
  node -e '
    const fs=require("fs"); const p=process.argv[1]; const v=process.argv[2];
    try {
      const c=fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,"")) : {};
      if (!c || typeof c!=="object" || Array.isArray(c)) throw new Error("a365-kit.config.json must contain a JSON object; it was not changed.");
      if (v.trim()==="") delete c.updateSource; else c.updateSource=v;
      fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
    } catch(e) { console.error(e.message); process.exit(1); }' "$KIT_CONFIG" "$SET_UPDATE_SOURCE"
  if [ -z "${SET_UPDATE_SOURCE//[[:space:]]/}" ]; then echo "  cleared the project update source."; else echo "  project update source set to: $SET_UPDATE_SOURCE"; fi
  echo "  written to a365-kit.config.json -- commit it so your whole team updates from the same place."
  resolve_update_source; echo "  --update will now use: $RESOLVED_SOURCE  [$SOURCE_ORIGIN]"
  exit 0
fi

# Skill folders to replace come from both the old and the new manifest, so a skill
# that upstream dropped is removed rather than left behind.
if [ "$UPDATE" -eq 1 ]; then
  # Node is a kit prerequisite, so it is the one JSON reader that is always present.
  # python3 is avoided: on Windows it often resolves to the Store alias stub, which
  # prints an error and returns nothing.
  command -v node >/dev/null 2>&1 || { echo "  node is required to read the kit manifest (it is a kit prerequisite)" >&2; exit 1; }
  resolve_update_source; UPDATE_FROM="$RESOLVED_SOURCE"
  echo "  source  : $UPDATE_FROM  [$SOURCE_ORIGIN]"
  if [[ "$SOURCE_ORIGIN" == 'a365-kit.config.json' || "$SOURCE_ORIGIN" == 'kit build default' ]] && ! is_http_source "$UPDATE_FROM"; then
    case "$UPDATE_FROM" in
      /*|[A-Za-z]:[\\/]*|\\\\*) ;;
      *) UPDATE_FROM="$KIT_ROOT/$UPDATE_FROM" ;;
    esac
  fi
  STAGE="$(node -e 'const fs=require("fs"),p=require("path");console.log(fs.mkdtempSync(p.join(process.argv[1],".a365-kit-update-")).split(p.sep).join("/"))' "$KIT_ROOT")"
  BACKED_UP=(); INSTALLED=(); UPDATE_DONE=0
  cleanup_update() {
    local status=$? failed=0 i relative
    trap - EXIT
    set +e
    if [ "$UPDATE_DONE" -eq 0 ]; then
      for ((i=${#INSTALLED[@]}-1; i>=0; i--)); do
        rm -rf "$KIT_ROOT/${INSTALLED[$i]}" || failed=1
      done
      for ((i=${#BACKED_UP[@]}-1; i>=0; i--)); do
        relative="${BACKED_UP[$i]}"
        if [ -e "$KIT_ROOT/$relative" ] || [ -L "$KIT_ROOT/$relative" ]; then
          echo "  Rollback destination still exists: $KIT_ROOT/$relative" >&2
          failed=1
        else
          mv "$STAGE/backup/$relative" "$KIT_ROOT/$relative" || failed=1
        fi
      done
    fi
    if [ "$failed" -eq 1 ]; then
      echo "  Rollback was incomplete; original files remain under $STAGE/backup." >&2
      status=1
    else
      rm -rf "$STAGE" || status=1
    fi
    exit "$status"
  }
  trap cleanup_update EXIT
  ZIP="$STAGE/kit.zip"
  if is_http_source "$UPDATE_FROM"; then
    echo "  downloading $UPDATE_FROM"
    curl -fsSL -o "$ZIP" "$UPDATE_FROM"
  else
    [ -f "$UPDATE_FROM" ] || { echo "  not found: $UPDATE_FROM" >&2; exit 1; }
    cp "$UPDATE_FROM" "$ZIP"
  fi
  # The archive is untrusted until its ZIP directory has been checked.
  node - "$ZIP" <<'NODE'
const fs = require('fs');
try {
  const zip = fs.readFileSync(process.argv[2]);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  }
  if (end < 0 || zip.readUInt32LE(end + 4) !== 0) throw new Error('Invalid or split ZIP archive.');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (count === 65535 || count !== zip.readUInt16LE(end + 8) || offset + zip.readUInt32LE(end + 12) !== end) {
    throw new Error('Invalid or unsupported ZIP directory.');
  }
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
    const length = zip.readUInt16LE(offset + 28);
    const next = offset + 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    if (next > end) throw new Error('Truncated ZIP directory.');
    const name = zip.subarray(offset + 46, offset + 46 + length).toString('utf8').replace(/\\/g, '/').replace(/\/$/, '');
    const type = (zip.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    if (!name || name.includes(':') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
        seen.has(name.toLowerCase()) || (type !== 0 && type !== 0x8000 && type !== 0x4000)) {
      throw new Error('Unsafe or duplicate archive path: ' + name);
    }
    seen.add(name.toLowerCase());
    const local = zip.readUInt32LE(offset + 42);
    if (local + 30 > offset || zip.readUInt32LE(local) !== 0x04034b50 ||
        !zip.subarray(local + 30, local + 30 + zip.readUInt16LE(local + 26))
          .equals(zip.subarray(offset + 46, offset + 46 + length))) {
      throw new Error('Invalid ZIP local entry: ' + name);
    }
    offset = next;
  }
  if (offset !== end) throw new Error('Invalid ZIP directory size.');
} catch (error) { console.error('  ' + error.message); process.exit(1); }
NODE
  NEW="$STAGE/new"; mkdir -p "$NEW"
  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$ZIP" -d "$NEW"
  else tar -xf "$ZIP" -C "$NEW"; fi          # bsdtar (macOS, Windows 10+) extracts zips
  node - "$NEW" "$KIT_ROOT" "$STAGE/plan" <<'NODE'
const fs = require('fs');
const path = require('path');
const [fresh, root, planFile] = process.argv.slice(2);
try {
  function manifest(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid kit manifest: ' + file);
    for (const key of ['kitVersion', 'upstreamVersion', 'upstreamCommit']) {
      if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error('Invalid ' + key + ' in kit manifest: ' + file);
    }
    const seen = new Set();
    for (const key of ['skills', 'addons']) {
      if (!Array.isArray(data[key])) throw new Error('Invalid ' + key + ' array in kit manifest: ' + file);
      for (const name of data[key]) {
        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name) || seen.has(name)) {
          throw new Error('Invalid or duplicate skill name in kit manifest: ' + file);
        }
        seen.add(name);
      }
    }
    if (!data.skills.includes('a365-setup')) throw new Error('Kit manifest is missing a365-setup: ' + file);
    return data;
  }
  function unlinked(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Linked archive entry: ' + file);
      if (stat.isDirectory()) unlinked(file);
    }
  }
  function target(relative, directory = false) {
    const stat = fs.lstatSync(path.join(root, relative), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Refusing to replace a linked project path: ' + relative);
    if (stat && directory && !stat.isDirectory()) throw new Error('Expected a project directory: ' + relative);
    return stat;
  }
  unlinked(fresh);
  target('.a365-kit');
  target('.a365-kit/KIT-VERSION.json');
  const next = manifest(path.join(fresh, '.a365-kit', 'KIT-VERSION.json'));
  const oldFile = path.join(root, '.a365-kit', 'KIT-VERSION.json');
  const old = fs.existsSync(oldFile) ? manifest(oldFile) : null;
  const names = new Set([...next.skills, ...next.addons]);
  const oldNames = new Set(old ? [...old.skills, ...old.addons] : []);
  const allNames = [...new Set([...names, ...oldNames])].sort();
  const files = ['agent365-kit.ps1', 'agent365-kit.sh', 'AGENT365-KIT-README.md'];
  const required = [...files, '.a365-kit/doctor.js', '.a365-kit/kit-version.js',
    '.a365-kit/settings-fragment.json', '.a365-kit/copilot-instructions.md'];
  for (const kind of ['skills', 'addons']) {
    for (const name of next[kind]) {
      required.push(`.a365-kit/${kind}/${name}/SKILL.md`, `.claude/skills/${name}/SKILL.md`, `.agents/skills/${name}/SKILL.md`);
    }
  }
  for (const relative of required) {
    const stat = fs.statSync(path.join(fresh, relative), { throwIfNoEntry: false });
    if (!stat?.isFile() || !stat.size) throw new Error('Incomplete kit archive: missing or empty ' + relative);
  }
  const plan = ['.a365-kit\t1'];
  for (const parent of ['.claude', '.agents']) {
    const disc = parent + '/skills';
    target(parent, true);
    target(disc, true);
    for (const name of allNames) {
      const relative = disc + '/' + name;
      if (target(relative) && !oldNames.has(name)) throw new Error('A new kit skill conflicts with a project-owned skill: ' + relative);
      plan.push(relative + '\t' + (names.has(name) ? '1' : '0'));
    }
  }
  for (const file of files) { target(file); plan.push(file + '\t1'); }
  const description = data => `kit v${data.kitVersion} / upstream v${data.upstreamVersion} (${data.upstreamCommit})`;
  console.log('  current : ' + (old ? description(old) : 'no kit installed'));
  console.log('  new     : ' + description(next));
  fs.writeFileSync(planFile, plan.join('\n') + '\n');
} catch (error) { console.error('  ' + error.message); process.exit(1); }
NODE
  while IFS=$'\t' read -r RELATIVE INSTALL; do
    if [ -e "$KIT_ROOT/$RELATIVE" ]; then
      mkdir -p "$(dirname "$STAGE/backup/$RELATIVE")"
      mv "$KIT_ROOT/$RELATIVE" "$STAGE/backup/$RELATIVE"
      BACKED_UP+=("$RELATIVE")
    fi
    if [ "$INSTALL" -eq 1 ]; then
      mkdir -p "$(dirname "$KIT_ROOT/$RELATIVE")"
      INSTALLED+=("$RELATIVE")
      mv "$NEW/$RELATIVE" "$KIT_ROOT/$RELATIVE"
    fi
  done < "$STAGE/plan"
  chmod +x "$KIT_ROOT/agent365-kit.sh"
  UPDATE_DONE=1
  echo "  kit updated. Your agent files, .env, a365 config and .claude/settings.json were not touched."
  echo "  re-run ./agent365-kit.sh to use the new launcher."
  exit 0
fi

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

head_()  { printf '\n%s%s%s\n' "$C_CYAN" "$1" "$C_RESET"; }
ok_()    { printf '  [%s ok %s] %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn_()  { printf '  [%swarn%s] %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
err_()   { printf '  [%sFAIL%s] %s\n' "$C_RED" "$C_RESET" "$1"; }
note_()  { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
cmd_()   { printf '      %s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }

printf '\n%sAgent 365 Onboarding Kit%s\n' "$C_BOLD" "$C_RESET"
printf '%s========================%s\n' "$C_DIM" "$C_RESET"

CANONICAL="$KIT_ROOT/.a365-kit/skills/a365-setup/SKILL.md"
if [ ! -f "$CANONICAL" ]; then
  echo ''
  err_ 'Could not find .a365-kit/skills/a365-setup/SKILL.md next to this script.'
  echo ''
  note_ 'Extract the kit into the ROOT of your agent project, so the kit folders sit'
  note_ 'alongside your agent source. Expected layout:'
  echo ''
  note_ '    your-agent-project/'
  note_ '      .a365-kit/'
  note_ '      .claude/skills/'
  note_ '      .agents/skills/'
  note_ '      agent365-kit.sh'
  note_ '      <your agent source>'
  echo ''
  exit 1
fi

SKILL_COUNT="$(find "$KIT_ROOT/.a365-kit/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
ADDON_COUNT=0
if [ -d "$KIT_ROOT/.a365-kit/addons" ]; then
  ADDON_COUNT="$(find "$KIT_ROOT/.a365-kit/addons" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
fi
TOTAL_SKILLS="$((SKILL_COUNT + ADDON_COUNT))"
echo ''
ok_ "Kit layout looks correct ($TOTAL_SKILLS skills: $SKILL_COUNT Microsoft, $ADDON_COUNT add-ons)"

cd "$KIT_ROOT"

if [ "$SKIP_DOCTOR" -eq 0 ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo ''
    err_ 'Node.js is not installed (or not on PATH).'
    echo ''
    note_ 'Node.js runs the prerequisite check and the skill validators. Install it:'
    echo ''
    cmd_ 'brew install node        # or https://nodejs.org'
    echo ''
    note_ 'Then open a NEW terminal and re-run this script.'
    echo ''
    exit 1
  fi

  if ! node "$KIT_ROOT/.a365-kit/doctor.js"; then
    note_ 'Install the missing prerequisites above, then re-run this script.'
    note_ '(Open a NEW terminal afterwards so PATH changes take effect.)'
    echo ''
    exit 1
  fi
fi

if [ "$DOCTOR_ONLY" -eq 1 ]; then
  note_ 'Prerequisite check complete. Re-run without --doctor-only for activation steps.'
  echo ''
  exit 0
fi

if [ "$WIRE_COPILOT" -eq 1 ]; then
  head_ 'Wiring GitHub Copilot instructions'
  SRC="$KIT_ROOT/.a365-kit/copilot-instructions.md"
  DST="$KIT_ROOT/.github/copilot-instructions.md"
  if [ ! -f "$SRC" ]; then
    err_ 'Missing .a365-kit/copilot-instructions.md -- kit may be incomplete.'
    exit 1
  else
    SOURCE_TEXT="$(cat "$SRC")"
    [[ "$SOURCE_TEXT" == *[![:space:]]* ]] || { err_ 'The kit Copilot instructions are empty.'; exit 1; }
    MARKER='<!-- agent365-kit:copilot-instructions -->'
    EXISTING=''
    if [ -f "$DST" ]; then EXISTING="$(cat "$DST")"; fi
    mkdir -p "$KIT_ROOT/.github"
    if [ ! -f "$DST" ]; then
      { printf '%s\n' "$MARKER"; cat "$SRC"; } > "$DST"
      ok_ 'Created .github/copilot-instructions.md'
    elif [[ "$EXISTING" == *"$MARKER"* || "${EXISTING//$'\r'/}" == *"${SOURCE_TEXT//$'\r'/}"* ]]; then
      ok_ 'Already wired -- .github/copilot-instructions.md contains the kit instructions.'
    else
      # Append rather than overwrite: this file is commonly project-owned.
      { printf '\n\n---\n\n%s\n' "$MARKER"; cat "$SRC"; } >> "$DST"
      ok_ 'Appended Agent 365 instructions to your existing .github/copilot-instructions.md'
    fi
  fi
fi

if [ "$WIRE_CLAUDE_HOOK" -eq 1 ]; then
  head_ 'Wiring the optional upstream-version notice'
  SETTINGS="$KIT_ROOT/.claude/settings.json"
  if [ -e "$SETTINGS" ] || [ -L "$SETTINGS" ]; then
    [ -f "$SETTINGS" ] || { err_ '.claude/settings.json exists but is not a file; it was not changed.'; exit 1; }
    warn_ 'This project already has .claude/settings.json -- leaving it untouched.'
    note_ 'Merge the "hooks" block from .a365-kit/settings-fragment.json by hand.'
  else
    mkdir -p "$KIT_ROOT/.claude"
    cp "$KIT_ROOT/.a365-kit/settings-fragment.json" "$SETTINGS"
    ok_ 'Created .claude/settings.json'
  fi
fi

has_claude=0; has_gh_skill=0; has_gh_copilot_launcher=0; has_copilot_cli=0; has_code=0
command -v claude >/dev/null 2>&1 && has_claude=1
command -v code   >/dev/null 2>&1 && has_code=1

# `gh skill` and `gh copilot` are built into gh 2.98+ and have no safe --version probe:
# `gh skill --version` errors and `gh copilot --version` can download the Copilot CLI.
if command -v gh >/dev/null 2>&1; then
  gh skill   --help >/dev/null 2>&1 && has_gh_skill=1
  gh copilot --help >/dev/null 2>&1 && has_gh_copilot_launcher=1
fi
if command -v copilot >/dev/null 2>&1; then
  has_copilot_cli=1
fi

head_ 'Detected CLIs'
[ "$has_claude" -eq 1 ] && ok_ 'Claude Code' || note_ '  --   Claude Code (not installed)'
if [ "$has_copilot_cli" -eq 1 ]; then
  ok_ 'GitHub Copilot CLI'
elif [ "$has_gh_copilot_launcher" -eq 1 ]; then
  note_ '  ~    GitHub Copilot CLI (available through gh copilot; resolved on first launch)'
else
  note_ '  --   GitHub Copilot CLI (not available)'
fi
[ "$has_gh_skill" -eq 1 ] && ok_ 'gh skill (agent-skill installer)' || note_ '  --   gh skill (needs gh 2.98+)'
[ "$has_code" -eq 1 ]     && ok_ 'VS Code' || note_ '  --   VS Code (not installed)'

head_ 'How to start onboarding'
echo ''
note_ 'The skills are already in place. Pick your CLI:'
echo ''

printf '  %sClaude Code%s\n' "$C_BOLD" "$C_RESET"
note_ '    Project skills in .claude/skills/ load automatically. From this folder:'
cmd_ 'claude'
note_ '    then type:'
cmd_ "\"$TRIGGER\""
echo ''

printf '  %sGitHub Copilot CLI%s\n' "$C_BOLD" "$C_RESET"
note_ '    Reads .agents/skills/ automatically. From this folder:'
if [ "$has_copilot_cli" -eq 1 ] || [ "$has_gh_copilot_launcher" -eq 0 ]; then cmd_ 'copilot'; else cmd_ 'gh copilot'; fi
note_ '    then type the phrase above. For extra grounding, also wire the'
note_ '    instructions file once:'
cmd_ './agent365-kit.sh --wire-copilot'
echo ''

printf '  %sVS Code (Copilot agent mode)%s\n' "$C_BOLD" "$C_RESET"
note_ '    Open this folder in VS Code, switch Copilot Chat to Agent mode,'
note_ '    confirm the skills with /skills list, then ask using the phrase above.'
echo ''

printf '  %sCursor, Codex, Gemini CLI, Amp, Cline, OpenCode, Warp, Antigravity%s\n' "$C_BOLD" "$C_RESET"
note_ '    All of these share the .agents/skills/ directory at project scope, so the'
note_ '    skills are already where they look. Open this folder and use the phrase above.'
echo ''

printf '  %sAny other agentic CLI%s\n' "$C_BOLD" "$C_RESET"
note_ '    Point it at .a365-kit/skills/a365-setup/SKILL.md and tell it to follow that file.'
note_ '    The skills are plain Markdown -- nothing is Claude-specific except the'
note_ '    validator hooks, which are optional.'
echo ''
note_ 'Full per-CLI walkthrough: docs/USING-WITH-YOUR-CLI.md in the kit repository.'
echo ''

head_ 'What you can ask for'
echo ''
note_ 'Say these in whichever CLI you picked. You do not need to know skill names.'
echo ''

printf '  %sCore%s
' "$C_BOLD" "$C_RESET"
cmd_ '"Onboard this agent to Agent 365."'
note_ '        blueprint, Entra identity, permissions'
cmd_ '"Add observability to this agent."'
note_ '        OpenTelemetry and the Agent 365 exporter'
cmd_ '"Add WorkIQ tools to this agent."'
note_ '        Microsoft 365 data: mail, calendar, Teams, SharePoint'
cmd_ '"Validate A365 code."'
note_ '        read-only check of telemetry, identity binding and grants'
cmd_ '"Add Purview DLP to my agent."'
note_ '        Purview blocks sensitive prompts before the model; replies can be audited'
echo ''

if [ -d "$KIT_ROOT/.a365-kit/addons" ]; then
  printf '  %sAdd-ons in this kit%s
' "$C_BOLD" "$C_RESET"
  for addon_dir in "$KIT_ROOT"/.a365-kit/addons/*/; do
    [ -d "$addon_dir" ] || continue
    addon_name="$(basename "$addon_dir")"
    case "$addon_name" in
      add-messaging-endpoint)
        cmd_ '"Make this agent chattable in Teams."'
        note_ '        HTTP host, dev tunnel, endpoint registration' ;;
      test-local-channel)
        cmd_ '"Let me test this agent locally."'
        note_ '        loopback-only dev channel: no tunnel, no tenant, no Teams' ;;
      add-mcp-server)
        cmd_ '"Add an MCP server."'
        note_ '        any external MCP server -- not governed by Agent 365' ;;
      add-lab-tools)
        cmd_ '"Add lab tools."'
        note_ '        local utilities: web fetch, encoders, hashing, text transforms' ;;
      add-java-agent)
        cmd_ '"Onboard this Java agent."'
        note_ '        hosting and telemetry for Java, which has no Microsoft SDK' ;;
      a365-kit)
        cmd_ '"Update the Agent 365 kit."'
        note_ '        replaces only the kit files, never your agent' ;;
      grant-observability-access)
        cmd_ '"Grant observability access to this agent."'
        note_ '        the maven-prod OtelWrite permission; an administrator confirms the grant' ;;
      *)
        cmd_ "\"$addon_name\""
        note_ "        see .a365-kit/addons/$addon_name/SKILL.md" ;;
    esac
  done
  echo ''
fi

printf '  %s---%s\n' "$C_DIM" "$C_RESET"
note_ 'a365-setup is the entry point. It checks prerequisites, asks which capabilities'
note_ 'you want, then hands off to make-ai-teammate or make-a365-agent.'
note_ 'For consent-aware setup, keep your approved options and use:'
cmd_ 'node ./.a365-kit/run-a365.mjs setup <subcommand> [options]'
note_ 'If setup says maven-prod OtelWrite needs admin consent, ask: "Grant observability access to this agent."'
echo ''

if [ "$LAUNCH" = 'claude' ]; then
  if [ "$has_claude" -eq 0 ]; then
    err_ 'Claude Code CLI not found on PATH.'
    note_ 'Install it with:  npm install -g @anthropic-ai/claude-code'
    echo ''
    exit 1
  fi
  head_ 'Launching Claude Code'
  echo ''
  exec claude "$TRIGGER"
fi
