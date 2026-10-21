import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';

// Async spawn: the helper server that holds the port lives in this process, so the event loop must stay free.
const doctor = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['scripts/doctor.mjs'], { env: { ...process.env, ...env }, cwd: new URL('..', import.meta.url).pathname });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', (status) => resolve({ status, out }));
});

test('doctor: a busy server port is a warning (exit 0); a port outside 6550-6599 is still a failure (exit 1)', async () => {
  const s = net.createServer();
  await new Promise((r) => { s.listen(6599, '127.0.0.1', r); });
  try {
    const busy = await doctor({ KILL_SWITCH_PORT: '6599' });
    assert.equal(busy.status, 0, busy.out);
    assert.match(busy.out, /^WARN\s+port:/m);
  } finally { await new Promise((r) => { s.close(r); }); }
  const out = await doctor({ KILL_SWITCH_PORT: '8080' });
  assert.equal(out.status, 1);
  assert.match(out.out, /^FAIL\s+port-range:/m);
});
