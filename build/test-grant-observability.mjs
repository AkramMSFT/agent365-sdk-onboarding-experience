// Offline tests for payload/.a365-kit/grant-observability.mjs against an in-memory Microsoft Graph.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = await import(pathToFileURL(path.join(here, '..', 'payload', '.a365-kit', 'grant-observability.mjs')).href);
const { main, EXIT, ROLE, OBSERVABILITY_APP_ID } = tool;

const TENANT = '11111111-1111-1111-1111-111111111111';
const OBS_SP = '22222222-2222-2222-2222-222222222222';
const ROLE_ID = '8f71190c-00c8-461d-a63b-f74abde9ba52';
const BP_APP = '33333333-3333-3333-3333-333333333333';
const BP_SP = '44444444-4444-4444-4444-444444444444';
const BP_OBJ = '55555555-5555-5555-5555-555555555555';
const ID_SP = '66666666-6666-6666-6666-666666666666';

function fakeGraph({ obsExists = true, grants = [], assignments = {}, deny = new Set(), conflict = new Set(), inheritable = [OBSERVABILITY_APP_ID] } = {}) {
  const writes = [];
  const state = { grants: grants.map(g => ({ ...g })), assignments: structuredClone(assignments) };
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const filter = u.searchParams.get('$filter') ?? '';
    const method = init.method ?? 'GET';
    assert.match(init.headers.authorization, /^Bearer fake\./);
    if (method !== 'GET') writes.push({ method, path: p, body: JSON.parse(init.body) });
    if (method === 'GET' && p === '/v1.0/servicePrincipals' && filter.includes(OBSERVABILITY_APP_ID)) {
      return reply(200, { value: obsExists ? [{ id: OBS_SP, displayName: 'maven-prod', appRoles: [{ id: ROLE_ID, value: ROLE, allowedMemberTypes: ['Application'] }] }] : [] });
    }
    if (method === 'GET' && p === '/v1.0/servicePrincipals' && filter.includes(BP_APP)) return reply(200, { value: [{ id: BP_SP, appId: BP_APP }] });
    let m = p.match(/^\/v1\.0\/servicePrincipals\/([0-9a-f-]+)\/appRoleAssignments$/);
    if (m && method === 'GET') return reply(200, { value: state.assignments[m[1]] ?? [] });
    if (m && method === 'POST') {
      if (deny.has(m[1])) return reply(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } });
      if (conflict.has(m[1])) return reply(409, { error: { code: 'Request_BadRequest', message: 'Permission being assigned already exists on the object' } });
      const body = JSON.parse(init.body);
      (state.assignments[m[1]] ??= []).push({ resourceId: body.resourceId, appRoleId: body.appRoleId });
      return reply(201, { id: 'new' });
    }
    if (p === '/v1.0/oauth2PermissionGrants' && method === 'GET') {
      return reply(200, { value: state.grants.filter(g => filter.includes(g.clientId) && filter.includes(g.resourceId)) });
    }
    if (p === '/v1.0/oauth2PermissionGrants' && method === 'POST') {
      if (deny.has('grant')) return reply(403, { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } });
      state.grants.push({ id: 'g-new', ...JSON.parse(init.body) });
      return reply(201, {});
    }
    m = p.match(/^\/v1\.0\/oauth2PermissionGrants\/(.+)$/);
    if (m && method === 'PATCH') {
      state.grants.find(g => g.id === m[1]).scope = JSON.parse(init.body).scope;
      return reply(204);
    }
    if (p === `/beta/applications/microsoft.graph.agentIdentityBlueprint/${BP_OBJ}/inheritablePermissions`) {
      return reply(200, { value: inheritable.map(resourceAppId => ({ resourceAppId })) });
    }
    return reply(404, { error: { code: 'NotFound', message: `unexpected ${method} ${p}` } });
  };
  return { fetch, writes, state };
}

const token = (tid = TENANT) => `fake.${Buffer.from(JSON.stringify({ tid, upn: 'admin@contoso.test' })).toString('base64url')}.sig`;
const configs = {
  'a365.config.json': { tenantId: TENANT },
  'a365.generated.config.json': { agentBlueprintId: BP_APP, agentBlueprintServicePrincipalObjectId: BP_SP, agentBlueprintObjectId: BP_OBJ, agenticAppId: ID_SP },
};

async function run(argv, graph, extra = {}) {
  const out = [], errs = [];
  const code = await main(argv, {
    fetch: graph?.fetch ?? (async () => { throw new Error('no network expected'); }),
    getToken: () => token(extra.tid),
    readJson: file => configs[path.basename(file)] ?? null,
    log: s => out.push(s), err: s => errs.push(s),
    interactive: extra.interactive ?? false,
    prompt: async () => extra.answer ?? false,
    sleep: async () => {},
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

test('check reports what is missing and writes nothing', async () => {
  const g = fakeGraph();
  const r = await run(['--check'], g);
  assert.equal(r.code, EXIT.missing);
  assert.match(r.out, /Application role on the agent identity\s+MISSING/);
  assert.match(r.out, /Delegated consent on the blueprint\s+MISSING/);
  assert.match(r.out, /--grant --principals identity/);
  assert.equal(g.writes.length, 0);
});

test('grant assigns the role to the agent identity and creates the delegated consent', async () => {
  const g = fakeGraph();
  const r = await run(['--grant', '--yes'], g);
  assert.equal(r.code, EXIT.ok, r.err);
  assert.deepEqual(g.writes.map(w => `${w.method} ${w.path}`), [
    `POST /v1.0/servicePrincipals/${ID_SP}/appRoleAssignments`,
    'POST /v1.0/oauth2PermissionGrants',
  ]);
  assert.deepEqual(g.writes[0].body, { principalId: ID_SP, resourceId: OBS_SP, appRoleId: ROLE_ID });
  assert.deepEqual(g.writes[1].body, { clientId: BP_SP, consentType: 'AllPrincipals', resourceId: OBS_SP, scope: ROLE });
});

test('an existing tenant-wide consent keeps its scopes when the role is added', async () => {
  const g = fakeGraph({ grants: [{ id: 'g1', clientId: BP_SP, resourceId: OBS_SP, consentType: 'AllPrincipals', scope: 'Other.Scope' }] });
  const r = await run(['--grant', '--yes', '--principals', 'identity'], g);
  assert.equal(r.code, EXIT.ok, r.err);
  const patch = g.writes.find(w => w.method === 'PATCH');
  assert.equal(patch.path, '/v1.0/oauth2PermissionGrants/g1');
  assert.equal(patch.body.scope, `Other.Scope ${ROLE}`);
});

test('a per-user consent is never modified; a tenant-wide one is created', async () => {
  const g = fakeGraph({ grants: [{ id: 'u1', clientId: BP_SP, resourceId: OBS_SP, consentType: 'Principal', scope: ROLE }] });
  const r = await run(['--grant', '--yes'], g);
  assert.equal(r.code, EXIT.ok, r.err);
  assert.ok(!g.writes.some(w => w.path.endsWith('/u1')));
  assert.ok(g.writes.some(w => w.method === 'POST' && w.path === '/v1.0/oauth2PermissionGrants'));
});

test('blueprint principal is granted when asked for, for exporters that sign in as the blueprint', async () => {
  const g = fakeGraph();
  const r = await run(['--grant', '--yes', '--principals', 'identity,blueprint', '--no-delegated'], g);
  assert.equal(r.code, EXIT.ok, r.err);
  assert.deepEqual(g.writes.map(w => w.path), [
    `/v1.0/servicePrincipals/${ID_SP}/appRoleAssignments`,
    `/v1.0/servicePrincipals/${BP_SP}/appRoleAssignments`,
  ]);
});

test('nothing is written when everything is already granted', async () => {
  const g = fakeGraph({
    assignments: { [ID_SP]: [{ resourceId: OBS_SP, appRoleId: ROLE_ID }] },
    grants: [{ id: 'g1', clientId: BP_SP, resourceId: OBS_SP, consentType: 'AllPrincipals', scope: ROLE }],
  });
  const r = await run(['--grant', '--yes'], g);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.out, /Nothing to do/);
  assert.equal(g.writes.length, 0);
});

test('without --yes and without a terminal it refuses and writes nothing', async () => {
  const g = fakeGraph();
  const r = await run(['--grant'], g);
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /Refusing to grant without confirmation/);
  assert.equal(g.writes.length, 0);
});

test('declining the prompt writes nothing', async () => {
  const g = fakeGraph();
  const r = await run(['--grant'], g, { interactive: true, answer: false });
  assert.equal(r.code, EXIT.missing);
  assert.equal(g.writes.length, 0);
});

test('insufficient privileges hand the admin the consent link and PowerShell', async () => {
  const g = fakeGraph({ deny: new Set([ID_SP, 'grant']) });
  const r = await run(['--grant', '--yes'], g);
  assert.equal(r.code, EXIT.grantFailed);
  assert.match(r.err, /lacks the role/);
  assert.match(r.err, /v2\.0\/adminconsent\?client_id=33333333-3333-3333-3333-333333333333&scope=api%3A%2F%2F9b975845/);
  assert.match(r.err, /redirect_uri=https%3A%2F%2Fentra\.microsoft\.com%2FTokenAuthorize/);
  assert.match(r.err, new RegExp(`New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId '${ID_SP}'`));
});

test('a 409 on the role assignment counts as already present', async () => {
  const g = fakeGraph({ conflict: new Set([ID_SP]), grants: [{ id: 'g1', clientId: BP_SP, resourceId: OBS_SP, consentType: 'AllPrincipals', scope: ROLE }] });
  const r = await run(['--grant', '--yes'], g);
  assert.match(r.out, /already present: application role on the agent identity/);
});

test('signed in to the wrong tenant stops before any call', async () => {
  const g = fakeGraph();
  const r = await run(['--check'], g, { tid: '99999999-9999-9999-9999-999999999999' });
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /az login --tenant 11111111/);
});

test('a tenant without the observability service principal gets the create command', async () => {
  const r = await run(['--check'], fakeGraph({ obsExists: false }));
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /az ad sp create --id 9b975845-388f-4429-889e-eab1ef63949c/);
});

test('missing inheritance is reported after a successful grant', async () => {
  const r = await run(['--grant', '--yes'], fakeGraph({ inheritable: [] }));
  assert.equal(r.code, EXIT.ok);
  assert.match(r.out, /Inherited by agent identities\s+no/);
  assert.match(r.out, /does not list the observability API among its inheritable permissions/);
});

test('print-commands calls nothing and prints both hand-offs', async () => {
  const r = await run(['--print-commands', '--principals', 'identity,blueprint'], null);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.out, /adminconsent/);
  assert.match(r.out, /Connect-MgGraph -TenantId '11111111/);
  assert.equal((r.out.match(/New-MgServicePrincipalAppRoleAssignment/g) ?? []).length, 2);
});

test('print-commands looks up the blueprint by appId when its object id is unknown', async () => {
  const saved = configs['a365.generated.config.json'];
  configs['a365.generated.config.json'] = { agentBlueprintId: BP_APP, agenticAppId: ID_SP };
  try {
    const r = await run(['--print-commands', '--principals', 'blueprint'], null);
    assert.equal(r.code, EXIT.ok);
    assert.match(r.out, new RegExp(`\\$blueprintSp = Get-MgServicePrincipal -Filter "appId eq '${BP_APP}'"`));
    assert.match(r.out, /-ServicePrincipalId \$blueprintSp\.Id -PrincipalId \$blueprintSp\.Id/);
  } finally { configs['a365.generated.config.json'] = saved; }
});

test('print-commands says why there is no consent link when the blueprint appId is unknown', async () => {
  const saved = configs['a365.generated.config.json'];
  configs['a365.generated.config.json'] = { agentBlueprintServicePrincipalObjectId: BP_SP, agenticAppId: ID_SP };
  try {
    const r = await run(['--print-commands'], null);
    assert.equal(r.code, EXIT.ok);
    assert.doesNotMatch(r.out, /adminconsent/);
    assert.match(r.out, /blueprint appId is unknown/);
  } finally { configs['a365.generated.config.json'] = saved; }
});

test('the suggested grant command keeps the options the check was given', async () => {
  const r = await run(['--check', '--tenant', TENANT, '--config-dir', 'my agent'], fakeGraph());
  assert.equal(r.code, EXIT.missing);
  assert.match(r.out, new RegExp(`--grant --principals identity --config-dir "my agent" --tenant ${TENANT}$`, 'm'));
});

test('a grant that is not visible at first is re-read before it is reported', async () => {
  const g = fakeGraph();
  let stale = 1;
  const fetch = async (url, init = {}) => {
    const read = (init.method ?? 'GET') === 'GET' && url.includes('/appRoleAssignments');
    if (read && g.writes.length && stale-- > 0) return { ok: true, status: 200, text: async () => '{"value":[]}' };
    return g.fetch(url, init);
  };
  const r = await run(['--grant', '--yes', '--no-delegated'], { fetch });
  assert.equal(r.code, EXIT.ok, r.err);
});

test('a grant that never becomes visible says so instead of reporting a failure', async () => {
  const g = fakeGraph();
  const fetch = async (url, init = {}) => {
    const read = (init.method ?? 'GET') === 'GET' && url.includes('/appRoleAssignments');
    return read && g.writes.length ? { ok: true, status: 200, text: async () => '{"value":[]}' } : g.fetch(url, init);
  };
  const r = await run(['--grant', '--yes', '--no-delegated'], { fetch });
  assert.equal(r.code, EXIT.grantFailed);
  assert.match(r.err, /accepted every grant, but they are not visible yet/);
  assert.doesNotMatch(r.err, /Could not grant/);
});

test('a project without a tenant id uses the tenant az is signed in to', async () => {
  const saved = configs['a365.config.json'];
  configs['a365.config.json'] = {};
  try {
    const out = [];
    const code = await main(['--print-commands'], { readJson: f => configs[path.basename(f)] ?? null, currentTenant: () => TENANT, log: s => out.push(s), err: () => {} });
    assert.equal(code, EXIT.ok);
    assert.match(out.join('\n'), /Tenant\s+11111111-1111-1111-1111-111111111111 \(from az/);
  } finally { configs['a365.config.json'] = saved; }
});

test('bad arguments are rejected', async () => {
  assert.equal((await run(['--principals', 'everyone'], null)).code, EXIT.usage);
  assert.equal((await run(['--tenant'], null)).code, EXIT.usage);
  assert.equal((await run(['--agent-identity-sp', 'not-a-guid'], null)).code, EXIT.usage);
});
