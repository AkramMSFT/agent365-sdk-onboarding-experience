#!/usr/bin/env node
// Checks and grants the Agent 365 observability permission (Agent365.Observability.OtelWrite)
// for an onboarded agent: the delegated consent on the blueprint, and the application role on
// the agent identity and, when its exporter signs in as the blueprint, on the blueprint.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const OBSERVABILITY_APP_ID = '9b975845-388f-4429-889e-eab1ef63949c';
export const OBSERVABILITY_URI = `api://${OBSERVABILITY_APP_ID}`;
export const ROLE = 'Agent365.Observability.OtelWrite';
const GRAPH = 'https://graph.microsoft.com';
const CONSENT_REDIRECT = 'https://entra.microsoft.com/TokenAuthorize';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EXIT = { ok: 0, usage: 2, missing: 3, grantFailed: 4 };

const HELP = `Usage: node .a365-kit/grant-observability.mjs [--check | --grant | --print-commands] [options]

  --check              Read-only. Report what is granted and what is missing (default).
  --grant              Grant what is missing. Needs an administrator signed in to az.
  --print-commands     Print the admin-consent link and PowerShell commands; call nothing.

  --principals LIST    Who gets the application role: identity, blueprint, or identity,blueprint.
                       Default: identity. Add blueprint when the agent's exporter signs in with
                       the blueprint's own client credentials (the Java add-on, Go, Rust).
  --no-delegated       Skip the delegated consent on the blueprint.
  --config-dir DIR     Folder holding a365.config.json and a365.generated.config.json (default: .).
  --tenant ID          Override the tenant id from a365.config.json.
  --blueprint-app-id ID, --blueprint-sp ID, --agent-identity-sp ID
                       Override the ids read from a365.generated.config.json.
  --yes                Skip the confirmation prompt for --grant.

Exit codes: 0 in place, 2 usage or sign-in problem, 3 missing (check), 4 grant incomplete.
`;

export function parseArgs(argv) {
  const o = { mode: 'check', principals: ['identity'], delegated: true, configDir: '.', yes: false };
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.mode = 'help';
    else if (a === '--check') o.mode = 'check';
    else if (a === '--grant') o.mode = 'grant';
    else if (a === '--print-commands') o.mode = 'print';
    else if (a === '--no-delegated') o.delegated = false;
    else if (a === '--yes') o.yes = true;
    else if (a === '--principals') {
      o.principals = [...new Set(value(i++, a).split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
      if (!o.principals.length || o.principals.some(p => !['identity', 'blueprint'].includes(p))) {
        throw new UsageError('--principals takes identity, blueprint, or identity,blueprint');
      }
    }
    else if (a === '--config-dir') o.configDir = value(i++, a);
    else if (a === '--tenant') o.tenant = value(i++, a);
    else if (a === '--blueprint-app-id') o.blueprintAppId = value(i++, a);
    else if (a === '--blueprint-sp') o.blueprintSp = value(i++, a);
    else if (a === '--agent-identity-sp') o.identitySp = value(i++, a);
    else throw new UsageError(`Unknown option: ${a}`);
  }
  return o;
}

export class UsageError extends Error {}
export class GraphError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function resolveIds(o, read = readJson) {
  const dir = path.resolve(o.configDir);
  const cfg = read(path.join(dir, 'a365.config.json')) ?? {};
  const gen = read(path.join(dir, 'a365.generated.config.json')) ?? {};
  const ids = {
    tenant: o.tenant ?? cfg.tenantId,
    blueprintAppId: o.blueprintAppId ?? gen.agentBlueprintId,
    blueprintSp: o.blueprintSp ?? gen.agentBlueprintServicePrincipalObjectId,
    blueprintObjectId: gen.agentBlueprintObjectId,
    identitySp: o.identitySp ?? gen.agenticAppId,
  };
  for (const [k, v] of Object.entries(ids)) if (v != null && !GUID.test(v)) throw new UsageError(`${k} is not a GUID: ${v}`);
  if (!GUID.test(ids.blueprintAppId ?? '') && !GUID.test(ids.blueprintSp ?? '')) {
    throw new UsageError('No blueprint found: run from the agent project after a365 setup, or pass --blueprint-app-id.');
  }
  if (o.principals.includes('identity') && !GUID.test(ids.identitySp ?? '')) {
    throw new UsageError('No agent identity in a365.generated.config.json (agenticAppId). Finish a365 setup, pass --agent-identity-sp, or use --principals blueprint.');
  }
  return ids;
}

export function consentUrl(tenant, blueprintAppId) {
  return `https://login.microsoftonline.com/${tenant}/v2.0/adminconsent` +
    `?client_id=${blueprintAppId}` +
    `&scope=${encodeURIComponent(`${OBSERVABILITY_URI}/${ROLE}`)}` +
    `&redirect_uri=${encodeURIComponent(CONSENT_REDIRECT)}` +
    `&state=${randomUUID().replace(/-/g, '')}`;
}

export function powershellCommands(ids, principals) {
  const lines = [
    `Connect-MgGraph -TenantId '${ids.tenant}' -Scopes 'AppRoleAssignment.ReadWrite.All','Application.Read.All' -UseDeviceCode`,
    `$resourceSp = Get-MgServicePrincipal -Filter "appId eq '${OBSERVABILITY_APP_ID}'"`,
    `$roleId = ($resourceSp.AppRoles | Where-Object { $_.Value -eq '${ROLE}' }).Id`,
  ];
  for (const p of principals) {
    let sp = `'${p.id}'`;
    if (!p.id) {
      lines.push(`$blueprintSp = Get-MgServicePrincipal -Filter "appId eq '${p.appId}'"`);
      sp = '$blueprintSp.Id';
    }
    lines.push(`New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId ${sp} -PrincipalId ${sp} -ResourceId $resourceSp.Id -AppRoleId $roleId   # ${p.label}`);
  }
  return lines;
}

// Every argument is a constant or a validated GUID, so the Windows shell form (needed to run
// az.cmd) receives nothing it could interpret.
function az(args) {
  const r = process.platform === 'win32'
    ? spawnSync(`az ${args.join(' ')}`, { encoding: 'utf8', shell: true, timeout: 60_000 })
    : spawnSync('az', args, { encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

export function azTenant() {
  const r = az(['account', 'show', '--query', 'tenantId', '-o', 'tsv']);
  if (!r.ok || !GUID.test(r.out)) throw new UsageError('No tenant id in a365.config.json and az is not signed in. Pass --tenant, or run: az login');
  return r.out;
}

export function azToken(tenant) {
  if (!GUID.test(tenant ?? '')) throw new UsageError(`tenant is not a GUID: ${tenant}`);
  const r = az(['account', 'get-access-token', '--resource-type', 'ms-graph', '--tenant', tenant, '--query', 'accessToken', '-o', 'tsv']);
  if (!r.ok || !r.out) {
    throw new UsageError(`Could not get a Microsoft Graph token from az. Sign in as an administrator first:\n  az login --tenant ${tenant}`);
  }
  return r.out;
}

export function tokenClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return {}; }
}

function graphClient(token, fetchImpl) {
  const call = async (method, url, body) => {
    const res = await fetchImpl(GRAPH + url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
    if (!res.ok) throw new GraphError(res.status, json?.error?.code ?? '', json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b) };
}

const q = s => encodeURIComponent(s);

const PRINCIPALS = [['identity', 'agent identity', 'identitySp'], ['blueprint', 'blueprint', 'blueprintSp']];
const principalsFor = (o, ids) => PRINCIPALS.filter(([k]) => o.principals.includes(k)).map(([, label, idKey]) => ({ label, id: ids[idKey] }));

export async function resolveTargets(g, ids) {
  const found = (await g.get(`/v1.0/servicePrincipals?$filter=${q(`appId eq '${OBSERVABILITY_APP_ID}'`)}&$select=id,displayName,appRoles`)).value ?? [];
  if (!found.length) {
    throw new UsageError(`The Agent 365 observability API has no service principal in this tenant. An administrator can create it with:\n  az ad sp create --id ${OBSERVABILITY_APP_ID}`);
  }
  const resource = found[0];
  const role = (resource.appRoles ?? []).find(r => r.value === ROLE && (r.allowedMemberTypes ?? ['Application']).includes('Application'));
  if (!role) throw new UsageError(`${resource.displayName} does not expose the application role ${ROLE}.`);

  if (!GUID.test(ids.blueprintSp ?? '')) {
    const bp = (await g.get(`/v1.0/servicePrincipals?$filter=${q(`appId eq '${ids.blueprintAppId}'`)}&$select=id`)).value ?? [];
    if (!bp.length) throw new UsageError(`No service principal for blueprint appId ${ids.blueprintAppId} in this tenant.`);
    ids.blueprintSp = bp[0].id;
  }
  if (!GUID.test(ids.blueprintAppId ?? '')) {
    ids.blueprintAppId = (await g.get(`/v1.0/servicePrincipals/${ids.blueprintSp}?$select=appId`)).appId;
  }
  return { resource, role };
}

async function readInherited(g, ids) {
  if (!GUID.test(ids.blueprintObjectId ?? '')) return 'unknown';
  try {
    const inh = (await g.get(`/beta/applications/microsoft.graph.agentIdentityBlueprint/${ids.blueprintObjectId}/inheritablePermissions`)).value ?? [];
    return inh.some(x => (x.resourceAppId ?? '').toLowerCase() === OBSERVABILITY_APP_ID) ? 'yes' : 'no';
  } catch { return 'unknown'; }
}

export async function inspect(g, ids, o, { resource, role }, inherited) {
  const principals = principalsFor(o, ids);
  const readDelegated = async () => {
    const grants = (await g.get(`/v1.0/oauth2PermissionGrants?$filter=${q(`clientId eq '${ids.blueprintSp}' and resourceId eq '${resource.id}'`)}`)).value ?? [];
    const tenantWide = grants.find(x => x.consentType === 'AllPrincipals');
    return { grant: tenantWide ?? null, granted: !!tenantWide && (tenantWide.scope ?? '').split(' ').includes(ROLE) };
  };
  const [delegated, inh] = await Promise.all([
    o.delegated ? readDelegated() : null,
    inherited ?? readInherited(g, ids),
    ...principals.map(async p => {
      const assignments = (await g.get(`/v1.0/servicePrincipals/${p.id}/appRoleAssignments`)).value ?? [];
      p.granted = assignments.some(a => a.resourceId === resource.id && a.appRoleId === role.id);
    }),
  ]);
  return { resource, role, principals, delegated, inherited: inh };
}

export function missing(state) {
  return [
    ...state.principals.filter(p => !p.granted).map(p => `application role on the ${p.label}`),
    ...(state.delegated && !state.delegated.granted ? ['delegated consent on the blueprint'] : []),
  ];
}

function report(log, ids, state) {
  const mark = ok => (ok ? 'granted' : 'MISSING');
  log(`Observability API   ${state.resource.displayName} (${state.resource.id})`);
  log(`Permission          ${ROLE}`);
  for (const p of state.principals) log(`  Application role on the ${p.label.padEnd(15)} ${mark(p.granted)}   ${p.id}`);
  if (state.delegated) {
    log(`  Delegated consent on the blueprint     ${mark(state.delegated.granted)}   ${ids.blueprintSp}`);
    log(`  Inherited by agent identities           ${state.inherited}`);
  }
}

async function confirm(o, deps, todo) {
  if (o.yes) return true;
  if (!deps.interactive) {
    throw new UsageError('Refusing to grant without confirmation. Re-run in a terminal, or add --yes once an administrator has approved.');
  }
  return deps.prompt(`Grant ${todo.join(' and ')}? [y/N] `);
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? (s => process.stdout.write(s + '\n'));
  const err = deps.err ?? (s => process.stderr.write(s + '\n'));
  try {
    const o = parseArgs(argv);
    if (o.mode === 'help') { log(HELP); return EXIT.ok; }
    const ids = resolveIds(o, deps.readJson);
    if (!ids.tenant) {
      ids.tenant = (deps.currentTenant ?? azTenant)();
      log(`Tenant              ${ids.tenant} (from az; a365.config.json has none)`);
    }

    if (o.mode === 'print') {
      // resolveIds guarantees an identity id, and a blueprint appId whenever its object id is unknown.
      const principals = principalsFor(o, ids).map(p => (GUID.test(p.id ?? '') ? p : { label: p.label, appId: ids.blueprintAppId }));
      if (o.delegated && GUID.test(ids.blueprintAppId ?? '')) {
        log('Delegated consent: a Global Administrator opens this link, signs in and accepts:');
        log('  ' + consentUrl(ids.tenant, ids.blueprintAppId));
      } else if (o.delegated) {
        log('Delegated consent: the blueprint appId is unknown, so no consent link can be built. Pass --blueprint-app-id.');
      }
      log('Application role: an Application Administrator or Global Administrator runs, in PowerShell:');
      for (const l of powershellCommands(ids, principals)) log('  ' + l);
      return EXIT.ok;
    }

    const token = (deps.getToken ?? azToken)(ids.tenant);
    const claims = tokenClaims(token);
    if (claims.tid && claims.tid.toLowerCase() !== ids.tenant.toLowerCase()) {
      throw new UsageError(`az is signed in to tenant ${claims.tid}, but the agent is in ${ids.tenant}. Run: az login --tenant ${ids.tenant}`);
    }
    log(`Signed in as        ${claims.upn ?? claims.unique_name ?? claims.oid ?? 'unknown'} (tenant ${ids.tenant})`);
    const g = graphClient(token, deps.fetch ?? fetch);

    const targets = await resolveTargets(g, ids);
    let state = await inspect(g, ids, o, targets);
    report(log, ids, state);
    let todo = missing(state);
    if (!todo.length) { log('Nothing to do: the observability permission is in place.'); return EXIT.ok; }
    if (o.mode === 'check') {
      const passed = [['--config-dir', o.configDir === '.' ? null : o.configDir], ['--tenant', o.tenant],
        ['--blueprint-app-id', o.blueprintAppId], ['--blueprint-sp', o.blueprintSp], ['--agent-identity-sp', o.identitySp]]
        .filter(([, v]) => v).map(([flag, v]) => ` ${flag} ${/\s/.test(v) ? `"${v}"` : v}`).join('');
      log(`Missing: ${todo.join('; ')}. An administrator can grant it with:`);
      log(`  node .a365-kit/grant-observability.mjs --grant --principals ${o.principals.join(',')}${o.delegated ? '' : ' --no-delegated'}${passed}`);
      return EXIT.missing;
    }

    if (!(await confirm(o, deps, todo))) { log('Nothing changed.'); return EXIT.missing; }

    const failures = [];
    for (const p of state.principals.filter(x => !x.granted)) {
      try {
        await g.post(`/v1.0/servicePrincipals/${p.id}/appRoleAssignments`, { principalId: p.id, resourceId: state.resource.id, appRoleId: state.role.id });
        log(`  granted: application role on the ${p.label}`);
      } catch (e) {
        if (e instanceof GraphError && e.status === 409) { log(`  already present: application role on the ${p.label}`); continue; }
        failures.push({ what: `application role on the ${p.label}`, error: e, principal: p });
      }
    }
    if (state.delegated && !state.delegated.granted) {
      try {
        if (state.delegated.grant) {
          const scopes = [...new Set([...(state.delegated.grant.scope ?? '').split(' ').filter(Boolean), ROLE])].join(' ');
          await g.patch(`/v1.0/oauth2PermissionGrants/${state.delegated.grant.id}`, { scope: scopes });
        } else {
          await g.post('/v1.0/oauth2PermissionGrants', { clientId: ids.blueprintSp, consentType: 'AllPrincipals', resourceId: state.resource.id, scope: ROLE });
        }
        log('  granted: delegated consent on the blueprint');
      } catch (e) {
        failures.push({ what: 'delegated consent on the blueprint', error: e });
      }
    }

    state = await inspect(g, ids, o, targets, state.inherited);
    // Entra can take a moment to show a write it has accepted, so re-read before calling it missing.
    const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let i = 0; i < 3 && !failures.length && missing(state).length; i++) {
      await sleep(5000);
      state = await inspect(g, ids, o, targets, state.inherited);
    }
    log('');
    report(log, ids, state);
    todo = missing(state);
    if (!todo.length) {
      if (state.delegated && state.inherited === 'no') {
        log('Note: the blueprint does not list the observability API among its inheritable permissions, so agent identities may not inherit the delegated consent. Re-run the permissions step of a365 setup as an Agent ID Administrator or Global Administrator.');
      }
      log('Done. New tokens pick up the permission; restart the agent so it requests one.');
      return EXIT.ok;
    }
    if (!failures.length) {
      err('Microsoft Graph accepted every grant, but they are not visible yet. Run --check again in a few minutes.');
      return EXIT.grantFailed;
    }
    for (const f of failures) err(`Could not grant ${f.what}: ${f.error.message}`);
    if (failures.some(f => f.error instanceof GraphError && [401, 403].includes(f.error.status))) {
      err('The signed-in account lacks the role for this. Hand these to an administrator instead:');
      if (state.delegated && !state.delegated.granted) err('  Global Administrator, open and accept: ' + consentUrl(ids.tenant, ids.blueprintAppId));
      const rolePrincipals = failures.filter(f => f.principal).map(f => f.principal);
      if (rolePrincipals.length) {
        err('  Application Administrator or Global Administrator, in PowerShell:');
        for (const l of powershellCommands(ids, rolePrincipals)) err('    ' + l);
      }
    }
    return EXIT.grantFailed;
  } catch (e) {
    if (e instanceof UsageError) { err(e.message); return EXIT.usage; }
    if (e instanceof GraphError) { err(`Microsoft Graph returned ${e.status} ${e.code}: ${e.message}`); return EXIT.usage; }
    throw e;
  }
}

// Real paths on both sides, so a symlinked or junctioned launch path still counts as direct.
function launchedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (launchedDirectly()) {
  const interactive = process.stdin.isTTY === true;
  const prompt = async question => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
  };
  main(process.argv.slice(2), { interactive, prompt }).then(code => { process.exitCode = code; });
}
