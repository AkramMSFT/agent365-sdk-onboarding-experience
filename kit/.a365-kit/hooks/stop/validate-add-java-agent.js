#!/usr/bin/env node
// Checks that a Java agent has the pieces the Microsoft SDKs would otherwise provide:
// an HTTP host on /api/messages, inbound JWT validation, a reply path and, if
// observability was added, a correctly shaped OTLP exporter. Static file checks only,
// with no network access and no build.

'use strict';

const path = require('path');
const { cwd, read, exists, scan, finish } = require('../lib/kit-validator');
const { readEnvValue, selectEnvFiles, envFlagEnabled } = require('../lib/env-config');

const issues = [];

const isMaven = exists(path.join(cwd, 'pom.xml'));
const isGradle = exists(path.join(cwd, 'build.gradle')) || exists(path.join(cwd, 'build.gradle.kts'));
if (!isMaven && !isGradle) {
  finish([], { note: 'No pom.xml or build.gradle -- not a Java project; add-java-agent not applicable' });
}

// Maven and Gradle put sources at src/main/java/<group>/<artifact>/, deeper than
// scanProject's default maxDepth of 5, where the default would find no .java files.
const javaTexts = scan(12).filter(f => f.endsWith('.java')).map(read);
const anyJava = (...patterns) => javaTexts.some(c => patterns.every(p => c.includes(p)));

if (javaTexts.length === 0) {
  issues.push('No .java files found -- run the add-java-agent skill to generate the hosting layer');
}

const buildFile = isMaven
  ? read(path.join(cwd, 'pom.xml'))
  : read(path.join(cwd, 'build.gradle')) + read(path.join(cwd, 'build.gradle.kts'));
if (!buildFile.includes('jackson-databind')) {
  issues.push('jackson-databind is not declared in the build file -- the host cannot parse activities');
}
if (!buildFile.includes('nimbus-jose-jwt')) {
  issues.push('nimbus-jose-jwt is not declared in the build file -- inbound tokens cannot be validated');
}

if (!anyJava('/api/messages')) {
  issues.push('No .java file serves /api/messages -- Teams has nowhere to deliver activities');
}

// Inbound validation is the security boundary: a tunnelled endpoint without it
// treats any request that reaches the URL as a real turn.
const validatesInbound = anyJava('Authorization') &&
  (anyJava('login.botframework.com') || anyJava('JWKSource') || anyJava('JWTProcessor'));
if (!validatesInbound) {
  issues.push('No inbound JWT validation found -- the endpoint would accept unauthenticated requests. ' +
    'Add InboundTokenValidator from references/java-endpoint.md');
}

// Replies must go to the activity's serviceUrl, not a hardcoded host.
if (!anyJava('serviceUrl')) {
  issues.push('No .java file reads serviceUrl from the inbound activity -- replies cannot reach the channel');
}

const hasExporter = anyJava('otlp/agents') || anyJava('gen_ai.operation.name');
if (hasExporter) {
  for (const attr of ['gen_ai.operation.name', 'microsoft.tenant.id', 'gen_ai.agent.id']) {
    if (!anyJava(attr)) {
      issues.push(`Exporter does not set ${attr} -- spans without all three required attributes are dropped by the service with a success response`);
    }
  }
  // Stock OTLP encoders emit attributes as a keyValue array; this API wants a plain object.
  // Match the quoted form a JSON builder would use, so comments explaining the
  // difference, including the reference's own, do not trip the check.
  if (anyJava('"stringValue"')) {
    issues.push('Exporter appears to emit OTLP keyValue attributes ("stringValue") -- Agent 365 expects a plain JSON object');
  }
  const envFiles = selectEnvFiles(['.env', '.env.example'].map(f => path.join(cwd, f)).filter(exists));
  if (envFiles.some(f => readEnvValue(f, 'ENABLE_A365_OBSERVABILITY_EXPORTER') !== undefined) &&
      !envFlagEnabled(envFiles, 'ENABLE_A365_OBSERVABILITY_EXPORTER')) {
    issues.push('ENABLE_A365_OBSERVABILITY_EXPORTER is present but not "true" -- the agent is instrumented but exports nothing; set it to true and restart');
  }
}

const generated = read(path.join(cwd, 'a365.generated.config.json'));
if (generated) {
  try {
    const cfg = JSON.parse(generated);
    if (!cfg.messagingEndpoint) {
      issues.push('a365.generated.config.json has no messagingEndpoint -- run a365 setup blueprint --update-endpoint <url> --m365');
    } else if (!String(cfg.messagingEndpoint).startsWith('https://')) {
      issues.push('messagingEndpoint is not HTTPS -- Teams will not deliver to it');
    }
  } catch {
    issues.push('a365.generated.config.json is not valid JSON');
  }
} else {
  issues.push('a365.generated.config.json not found -- run the a365-setup skill before adding the Java hosting layer');
}

finish(issues);
