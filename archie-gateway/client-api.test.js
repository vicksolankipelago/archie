'use strict';

// The operator control API surfaces a scope's owners/files/cron/etc. to a
// native client. These pin the read shapes and the degrade-visibly behaviour
// (empty + reason) for the stores that are vendor stubs or not yet wired, so a
// client tab never shows wrong data or a hard error.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createClientApi } = require('./client-api');

// Pull a handler off the router by method + path pattern. express stores them
// on router.stack[].route; matching by the path template keeps the test
// independent of registration order.
function handler(router, method, path) {
  for (const layer of router.stack) {
    const r = layer.route;
    if (r && r.path === path && r.methods[method]) {
      return r.stack[r.stack.length - 1].handle;
    }
  }
  throw new Error(`no ${method.toUpperCase()} ${path}`);
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const req = (params = {}, body = {}) => ({ params, body });

function build(overrides = {}) {
  const deps = {
    grants: {},
    approvalsStore: { approve() {}, deny() {}, listPending: () => [] },
    cronService: { list: () => [], runNow: () => {} },
    filesStore: { listFiles: async () => [] },
    owners: { ownersOf: async () => ({}) },
    marketplace: { getCatalog: () => ({}), getInstalls: () => ({}) },
    log: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return createClientApi(deps).router;
}

test('owners maps the DynamoDB owner map to a list', async () => {
  const router = build({
    owners: { ownersOf: async () => ({ U1: { displayName: 'You', role: 'owner' }, U2: {} }) },
  });
  const res = mockRes();
  await handler(router, 'get', '/:scope/owners')(req({ scope: 'dm-U1' }), res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.owners.find((o) => o.id === 'U1'), { id: 'U1', displayName: 'You', role: 'owner' });
  // Missing meta falls back to id + 'owner'.
  assert.deepEqual(res.body.owners.find((o) => o.id === 'U2'), { id: 'U2', displayName: 'U2', role: 'owner' });
});

test('files maps S3 records and treats an unconfigured store as empty', async () => {
  const ok = build({
    filesStore: { listFiles: async () => [{ key: 'dm-U1/report.pdf', filename: 'report.pdf', size: 10, lastModified: '2026-01-01T00:00:00Z' }] },
  });
  let res = mockRes();
  await handler(ok, 'get', '/:scope/files')(req({ scope: 'dm-U1' }), res);
  assert.equal(res.body.files[0].name, 'report.pdf');
  assert.equal(res.body.files[0].sizeBytes, 10);

  const broken = build({ filesStore: { listFiles: async () => { throw new Error('not configured'); } } });
  res = mockRes();
  await handler(broken, 'get', '/:scope/files')(req({ scope: 'dm-U1' }), res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.files, []);
});

test('cron lists only the scope\'s jobs', async () => {
  const router = build({
    cronService: { list: () => [{ id: 'a', agentId: 'dm-U1' }, { id: 'b', agentId: 'ch-C9' }], runNow: () => {} },
  });
  const res = mockRes();
  await handler(router, 'get', '/:scope/cron')(req({ scope: 'dm-U1' }), res);
  assert.deepEqual(res.body.jobs.map((j) => j.id), ['a']);
});

test('cron run-now calls the service; toggle is not wired (501)', async () => {
  let ran = null;
  const router = build({ cronService: { list: () => [], runNow: (id) => { ran = id; } } });
  let res = mockRes();
  await handler(router, 'post', '/:scope/cron/:id/run')(req({ scope: 'dm-U1', id: 'job1' }), res);
  assert.equal(ran, 'job1');
  assert.equal(res.body.ok, true);

  res = mockRes();
  await handler(router, 'post', '/:scope/cron/:id')(req({ scope: 'dm-U1', id: 'job1' }, { enabled: false }), res);
  assert.equal(res.statusCode, 501);
});

test('approvals decide validates the decision and calls the store', async () => {
  const calls = [];
  const router = build({
    approvalsStore: { approve: (id, who) => calls.push(['approve', id, who]), deny: (id, who) => calls.push(['deny', id, who]), listPending: () => [] },
  });
  let res = mockRes();
  await handler(router, 'post', '/:scope/approvals/:id')(req({ scope: 'dm-U1', id: 'ap1' }, { decision: 'approve' }), res);
  assert.deepEqual(calls[0], ['approve', 'ap1', 'operator']);

  res = mockRes();
  await handler(router, 'post', '/:scope/approvals/:id')(req({ scope: 'dm-U1', id: 'ap1' }, { decision: 'nope' }), res);
  assert.equal(res.statusCode, 400);
});

test('grants and approvals-list degrade visibly (empty + reason)', async () => {
  const router = build();
  let res = mockRes();
  await handler(router, 'get', '/:scope/grants')(req({ scope: 'dm-U1' }), res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.grants, []);
  assert.ok(res.body.reason);

  res = mockRes();
  await handler(router, 'get', '/:scope/approvals')(req({ scope: 'dm-U1' }), res);
  assert.deepEqual(res.body.approvals, []);
  assert.ok(res.body.reason);
});

test('skills/apps read the global marketplace maps', async () => {
  const router = build({
    marketplace: {
      getCatalog: () => ({ skills: { pdf: { name: 'PDF', description: 'd', capability: 'fs.read' } } }),
      getInstalls: () => ({ installs: { pdf: true }, connectors: { gh: { name: 'GitHub', connected: true, toolPrefix: 'github' } } }),
    },
  });
  let res = mockRes();
  await handler(router, 'get', '/:scope/skills')(req({ scope: 'dm-U1' }), res);
  assert.equal(res.body.skills[0].id, 'pdf');
  assert.equal(res.body.skills[0].installed, true);

  res = mockRes();
  await handler(router, 'get', '/:scope/apps')(req({ scope: 'dm-U1' }), res);
  assert.equal(res.body.apps[0].id, 'gh');
  assert.equal(res.body.apps[0].connected, true);
});
