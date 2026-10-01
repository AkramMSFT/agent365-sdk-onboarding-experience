// Runs the turn-reply helpers from the shipped note against errors shaped like the ones the
// SDKs raise, and checks that no host template sends exception text to the user.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { kit, noteBlocks, python, run, workdir } from './doc-harness.mjs';

const block = noteBlocks('turn-replies.md');

const pythonHarness = `
import asyncio, json, logging
from turn_replies import REFUSAL_REPLY, ERROR_REPLY, reply_for_error, send_turn_error

class ModelRefusalError(Exception): pass
class OpenAIContentFilterException(Exception): pass
class InputGuardrailTripwireTriggered(Exception): pass
class BadRequestError(Exception):
    def __init__(self, code):
        super().__init__("Error code: 400 secret-detail")
        self.code = code

def chained():
    try:
        raise BadRequestError("content_filter")
    except BadRequestError as inner:
        try:
            raise RuntimeError("wrapped") from inner
        except RuntimeError as outer:
            return outer

a, b = RuntimeError("a"), RuntimeError("b")
a.__context__, b.__context__ = b, a

cases = {
    "model_refusal": ModelRefusalError("refused"),
    "af_content_filter": OpenAIContentFilterException("filtered"),
    "guardrail": InputGuardrailTripwireTriggered("tripped"),
    "prompt_shield": BadRequestError("content_filter"),
    "chained": chained(),
    "group": ExceptionGroup("g", [ValueError("x"), ModelRefusalError("refused")]),
    "other_400": BadRequestError("invalid_value"),
    "plain": RuntimeError("secret-detail"),
    "cycle": a,
}
out = {name: ("refusal" if reply_for_error(e) == REFUSAL_REPLY else "error") for name, e in cases.items()}

class Context:
    sent = []
    async def send_activity(self, text): self.sent.append(text)

logging.disable(logging.CRITICAL)
context = Context()
asyncio.run(send_turn_error(context, RuntimeError("secret-detail")))
asyncio.run(send_turn_error(context, ModelRefusalError("refused")))
out["hook"] = context.sent
out["leaks"] = any("secret" in reply for reply in context.sent + [ERROR_REPLY, REFUSAL_REPLY])
print(json.dumps(out))
`;

const nodeHarness = `
import { replyForError, REFUSAL_REPLY } from './turnReplies.ts';

class ModelRefusalError extends Error { name = 'ModelRefusalError'; }
const coded = (code) => Object.assign(new Error('400 secret-detail'), { code });
const a = new Error('a');
const b = new Error('b', { cause: a });
a.cause = b;
const cases = {
  model_refusal: new ModelRefusalError('refused'),
  prompt_shield: coded('content_filter'),
  policy_message: new Error("400 The response was filtered due to the prompt triggering Azure OpenAI's content management policy."),
  body_code: Object.assign(new Error('400'), { error: { code: 'content_filter' } }),
  chained: new Error('wrapped', { cause: coded('content_filter') }),
  aggregate: new AggregateError([new Error('x'), new ModelRefusalError('refused')]),
  other_400: coded('invalid_value'),
  plain: new Error('secret-detail'),
  cycle: a,
  not_an_error: 'secret-detail',
};
const out = Object.fromEntries(Object.entries(cases).map(([k, e]) => [k, replyForError(e) === REFUSAL_REPLY ? 'refusal' : 'error']));
out.leaks = Object.values(cases).some((e) => replyForError(e).includes('secret'));
console.log(JSON.stringify(out));
`;

const csharpHarness = `
using System.Text.Json;
var cases = new Dictionary<string, Exception>
{
    ["prompt_shield"] = new Exception("HTTP 400 (: content_filter)"),
    ["policy_message"] = new Exception("The response was filtered due to the prompt triggering Azure OpenAI's content management policy."),
    ["inner"] = new InvalidOperationException("wrapped", new Exception("HTTP 400 (: content_filter)")),
    ["aggregate"] = new AggregateException(new Exception("x"), new Exception("HTTP 400 (: content_filter)")),
    ["other_400"] = new Exception("HTTP 400 (invalid_request_error: invalid_value) secret-detail"),
    ["plain"] = new Exception("secret-detail"),
};
var result = cases.ToDictionary(c => c.Key, c => TurnReplies.For(c.Value) == TurnReplies.Refusal ? "refusal" : "error");
result["leaks"] = cases.Values.Any(e => TurnReplies.For(e).Contains("secret")) ? "true" : "false";
Console.WriteLine(JsonSerializer.Serialize(result));
`;

const REFUSED = ['model_refusal', 'af_content_filter', 'guardrail', 'prompt_shield', 'chained', 'group'];

test('Python helper answers refusals and hides other errors', () => {
  const dir = workdir('turn-replies-', { 'turn_replies.py': block('python', 'def reply_for_error('), 'harness.py': pythonHarness });
  const out = run(python, ['harness.py'], dir);
  for (const name of REFUSED) assert.equal(out[name], 'refusal', name);
  for (const name of ['other_400', 'plain', 'cycle']) assert.equal(out[name], 'error', name);
  assert.equal(out.hook.length, 2, 'the turn error hook sends one reply per error');
  assert.equal(out.leaks, false, 'a reply contains the error text');
});

test('Node.js helper answers refusals and hides other errors', () => {
  const dir = workdir('turn-replies-', { 'turnReplies.ts': block('typescript', 'export function replyForError'), 'harness.ts': nodeHarness });
  const out = run(process.execPath, ['harness.ts'], dir);
  for (const name of ['model_refusal', 'prompt_shield', 'policy_message', 'body_code', 'chained', 'aggregate']) assert.equal(out[name], 'refusal', name);
  for (const name of ['other_400', 'plain', 'cycle', 'not_an_error']) assert.equal(out[name], 'error', name);
  assert.equal(out.leaks, false);
});

const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).status === 0;

test('.NET helper answers refusals and hides other errors', { skip: dotnet ? false : 'dotnet is not installed' }, () => {
  const dir = workdir('turn-replies-', {
    'TurnRepliesCheck.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>'
      + '<TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable>'
      + '</PropertyGroup></Project>',
    'TurnReplies.cs': block('csharp', 'public static class TurnReplies'),
    'Program.cs': csharpHarness,
  });
  const out = run('dotnet', ['run', '--nologo'], dir, 300_000);
  for (const name of ['prompt_shield', 'policy_message', 'inner', 'aggregate']) assert.equal(out[name], 'refusal', name);
  for (const name of ['other_400', 'plain']) assert.equal(out[name], 'error', name);
  assert.equal(out.leaks, 'false');
});

test('host templates send the helpers\' replies, never exception text', () => {
  const read = rel => fs.readFileSync(path.join(kit, ...rel.split('/')), 'utf8');
  const pyHost = read('addons/add-messaging-endpoint/references/python-messaging-endpoint.md');
  assert.match(pyHost, /self\._adapter\.on_turn_error = send_turn_error/);
  assert.match(pyHost, /await context\.send_activity\(reply_for_error\(error\)\)/);
  const pyTeammate = read('skills/make-ai-teammate/references/python-ai-teammate.md');
  assert.match(pyTeammate, /self\._adapter\.on_turn_error = send_turn_error/);
  assert.match(pyTeammate, /finish_reason", None\) == "content_filter"/);
  assert.match(read('skills/make-ai-teammate/references/nodejs-ai-teammate.md'), /await context\.sendActivity\(replyForError\(err\)\)/);
  assert.equal(read('skills/make-ai-teammate/references/dotnet-ai-teammate.md').match(/TurnReplies\.For\(exception\)/g)?.length, 2);

  const leaks = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const pattern of [
          /send_activity\(\s*f["'][^"'\n]*\{(e|err|error|exc|ex)\}/g,
          /sendActivity\(\s*`[^`]*\$\{[^}]*\b(err|error|e)\b[^}]*\}/g,
          /SendActivityAsync\(\s*\$"[^"\n]*\{(exception|ex|e|error)\.Message\}/g,
        ]) {
          for (const m of text.matchAll(pattern)) leaks.push(`${path.relative(kit, full)}: ${m[0].slice(0, 80)}`);
        }
      }
    }
  };
  walk(path.join(kit, 'skills'));
  walk(path.join(kit, 'addons'));
  assert.deepEqual(leaks, [], 'a template sends exception text to the user');
});
