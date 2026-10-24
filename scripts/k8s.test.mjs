// The hosted mock build's manifests and deploy script. Every check is an exit code or a file check: no node:test stdout is parsed.
// No cluster is contacted: kubectl is replaced by a stub in the apply test, and the stray-token case runs on a temp copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const K8S = path.join(ROOT, 'k8s');
const SCRIPT = path.join(K8S, 'deploy.sh');
const FILES = ['deployment.yaml', 'service.yaml', 'ingress.yaml'];
const GOOD = { NAMESPACE: 'demo-ns', IMAGE: 'ghcr.example.invalid/agent-kill-switch:0.1.0', SE_HOST: 'ai-demo.example.com' };
const read = (f) => fs.readFileSync(path.join(K8S, f), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ks-k8s-'));

// Run deploy.sh with a clean environment: only PATH and the given variables. Returns the exit code (and output, for messages).
function deploy(args, env = {}, script = SCRIPT) {
  const r = spawnSync('bash', [script, ...args], { env: { PATH: process.env.PATH, HOME: os.homedir(), ...env }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('manifests use only the owner tokens __IMAGE__ and __SE_HOST__, and no namespace field', () => {
  const tokens = new Set();
  for (const f of FILES) for (const m of read(f).matchAll(/__[A-Za-z0-9_]+__/g)) tokens.add(m[0]);
  assert.deepEqual([...tokens].sort(), ['__IMAGE__', '__SE_HOST__']);
  for (const f of FILES) {
    assert.doesNotMatch(read(f), /\$\{/, `${f}: no envsubst-style forms`);
    assert.doesNotMatch(read(f), /^\s*namespace:/m, `${f}: no namespace field (deploy.sh sets it)`);
  }
});

test('the Deployment is non-root uid 1000, read-only root filesystem, drops ALL, RuntimeDefault seccomp, no privilege escalation', () => {
  const d = read('deployment.yaml');
  assert.match(d, /runAsNonRoot: true/);
  assert.match(d, /runAsUser: 1000/);
  assert.match(d, /readOnlyRootFilesystem: true/);
  assert.match(d, /drop: \["ALL"\]/);
  assert.match(d, /allowPrivilegeEscalation: false/);
  assert.equal((d.match(/type: RuntimeDefault/g) || []).length, 2, 'seccomp on the pod and the container');
  assert.match(d, /automountServiceAccountToken: false/);
  assert.match(d, /enableServiceLinks: false/, 'no service-link env vars (they could collide with the live-setting refusal)');
});

test('readiness and liveness probe /api/health with a loopback Host header, and the pod has resource limits', () => {
  const d = read('deployment.yaml');
  assert.equal((d.match(/path: \/api\/health/g) || []).length, 2, 'readiness and liveness');
  assert.equal((d.match(/value: 127\.0\.0\.1:6550/g) || []).length, 2, 'both probes send the loopback Host');
  assert.match(d, /limits:\n\s+cpu: \S+\n\s+memory: \S+/);
});

test('the pod takes no secret: no secretKeyRef, secretRef or Secret volume, and no credential setting', () => {
  for (const f of FILES) {
    assert.doesNotMatch(read(f), /secretKeyRef|secretRef|secretName|kind: Secret/, `${f}: no secret`);
  }
  const d = read('deployment.yaml');
  assert.match(d, /name: MODE\n\s+value: se-mock/, 'the hosted build runs MODE=se-mock');
  assert.match(d, /name: KILL_SWITCH_PUBLIC_HOST\n\s+value: __SE_HOST__/);
});

test('a valid render exits 0 with no token left and the namespace, image and host in place', () => {
  const r = deploy(['--dry-run'], GOOD);
  assert.equal(r.status, 0, r.err);
  assert.doesNotMatch(r.out, /__[A-Za-z0-9_]+__/);
  assert.match(r.out, /image: ghcr\.example\.invalid\/agent-kill-switch:0\.1\.0/);
  assert.match(r.out, /host: ai-demo\.example\.com/);
  assert.match(r.err, /Nothing applied/);
});

test('every missing or invalid input is refused with exit 2 (NAMESPACE has no default)', () => {
  const cases = [
    ['NAMESPACE missing', { ...GOOD, NAMESPACE: undefined }],
    ['NAMESPACE empty', { ...GOOD, NAMESPACE: '' }],
    ['NAMESPACE not a DNS label', { ...GOOD, NAMESPACE: 'Demo_NS' }],
    ['IMAGE missing', { ...GOOD, IMAGE: undefined }],
    ['IMAGE uses latest', { ...GOOD, IMAGE: 'ghcr.example.invalid/agent-kill-switch:latest' }],
    ['IMAGE has no tag', { ...GOOD, IMAGE: 'ghcr.example.invalid/agent-kill-switch' }],
    ['IMAGE has the registry port but no tag', { ...GOOD, IMAGE: 'ghcr.example.invalid:5000/agent-kill-switch' }],
    ['IMAGE carries a sed metacharacter', { ...GOOD, IMAGE: 'ghcr.example.invalid/a|b:0.1.0' }],
    ['IMAGE carries an ampersand', { ...GOOD, IMAGE: 'ghcr.example.invalid/a&b:0.1.0' }],
    ['SE_HOST missing', { ...GOOD, SE_HOST: undefined }],
    ['SE_HOST has a scheme', { ...GOOD, SE_HOST: 'https://ai-demo.example.com' }],
    ['SE_HOST has a port', { ...GOOD, SE_HOST: 'ai-demo.example.com:443' }],
    ['SE_HOST is localhost', { ...GOOD, SE_HOST: 'localhost' }],
    ['SE_HOST is an IP address', { ...GOOD, SE_HOST: '10.0.0.7' }],
  ];
  for (const [name, env] of cases) {
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
    const r = deploy(['--dry-run'], clean);
    assert.equal(r.status, 2, `${name}: exit ${r.status}`);
  }
});

test('an unknown argument is a usage error (exit 2)', () => {
  assert.equal(deploy(['--apply'], GOOD).status, 2);
});

test('a placeholder left in the manifests is refused with exit 1, on a temp copy of the deploy directory', () => {
  const dir = tmp();
  for (const f of [...FILES, 'deploy.sh']) fs.copyFileSync(path.join(K8S, f), path.join(dir, f));
  fs.appendFileSync(path.join(dir, 'service.yaml'), '  annotations:\n    owner: __OWNER_NAMESPACE__\n');
  const r = deploy(['--dry-run'], GOOD, path.join(dir, 'deploy.sh'));
  assert.equal(r.status, 1, `exit ${r.status}`);
  assert.equal(r.out, '', 'nothing is printed for a refused render');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a leftover ${...} form is refused with exit 1 as well', () => {
  const dir = tmp();
  for (const f of [...FILES, 'deploy.sh']) fs.copyFileSync(path.join(K8S, f), path.join(dir, f));
  fs.appendFileSync(path.join(dir, 'ingress.yaml'), '# ${NAMESPACE}\n');
  assert.equal(deploy(['--dry-run'], GOOD, path.join(dir, 'deploy.sh')).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply without OWNER_APPROVED=1 is refused with exit 3 and never calls kubectl', () => {
  const bin = tmp();
  const log = path.join(bin, 'kubectl-called');
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/usr/bin/env bash\necho called >> "${log}"\nexit 0\n`, { mode: 0o755 });
  const r = deploy([], { ...GOOD, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 3, `exit ${r.status}`);
  assert.equal(fs.existsSync(log), false, 'kubectl was not called');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('with OWNER_APPROVED=1 apply calls kubectl once, in the namespace, on the rendered file (a stub: no cluster is contacted)', () => {
  const bin = tmp();
  const log = path.join(bin, 'args');
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\nexit 0\n`, { mode: 0o755 });
  const r = deploy([], { ...GOOD, OWNER_APPROVED: '1', PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.err);
  const args = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 4), ['-n', 'demo-ns', 'apply', '-f']);
  fs.rmSync(bin, { recursive: true, force: true });
});
