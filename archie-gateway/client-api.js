'use strict';

// Operator-surface control API for a native client (archie-mac).
//
// WHY A SEPARATE MOUNT. The agent routes (/cron, /approvals, /api, /spawn) are
// TOKEN-ONLY by design (phase 4): an agent acts only on its OWN scope, derived
// from the token signature, and naming another scope is unrepresentable. A
// desktop operator client has no per-turn token — it is "people", like
// /simulate and /reload, which authenticate with the shared secret.
//
// So this router lives on its own prefix with the OPERATOR credential (shared
// secret via x-dispatcher-secret) and takes the scope EXPLICITLY in the path.
// It is deliberately separate — like /admin/cron — so "an operator client acted
// on a scope" is a distinct, auditable signal, never confused with an agent
// acting on itself, and so it is deletable as one unit.
//
// It is a thin delegating layer over the same stores the agent routes and App
// Home use (grants, approvals-store, cron-service, files-store, owners,
// marketplace). Where a store is a vendor stub in the OSS build (skills/apps),
// the endpoint returns an empty list with a reason, which the client renders as
// "unavailable" rather than an error.

const express = require('express');

/**
 * @param deps.requireOperator  middleware: 401 unless the shared secret matches
 * @param deps.grants           ./grants module
 * @param deps.approvalsStore   ./approvals-store module
 * @param deps.cronService      cron service (may be null before init)
 * @param deps.filesStore       ./files-store instance
 * @param deps.owners           ./owners instance
 * @param deps.marketplace      ./marketplace module (vendor stub in OSS)
 * @param deps.resolveAgent     (scope) -> agentId or null   (routing check)
 * @param deps.log              pino-shaped logger
 */
function createClientApi(deps = {}) {
  const {
    requireOperator, grants, approvalsStore, cronService,
    filesStore, owners, marketplace, log = console,
  } = deps;

  const router = express.Router();
  if (requireOperator) router.use(requireOperator);

  const fail = (res, err, code = 502) => {
    log.error?.({ err: err?.message || String(err) }, 'client-api error');
    res.status(code).json({ ok: false, error: err?.message || String(err) });
  };

  // ── Grants (permissions) ────────────────────────────────────────────────
  //
  // NOTE: the grants module's read/write path needs a DynamoDB doc + table and a
  // multi-step read-then-describe (readGrant -> loadPolicyVerdicts ->
  // describeCapabilities), and the writes take (doc, table, agentId, cap,
  // userId). Wiring that from here safely is a follow-up; until then these
  // return an explicit "unavailable" so the client's Permissions tab degrades
  // visibly rather than showing wrong data or corrupting a grant row.
  router.get('/:scope/grants', async (req, res) => {
    res.json({ ok: true, grants: [], reason: 'grants-read-not-wired' });
  });
  router.post('/:scope/grants', async (req, res) => {
    res.status(501).json({ ok: false, error: 'grants-write-not-wired' });
  });

  // ── Approvals ─────────────────────────────────────────────────────────────
  // The store's listPending(userId) is approver-keyed. An operator surface wants
  // everything pending for the scope, which needs a list-by-scope method the
  // store doesn't expose. Until it does, return empty with a reason so the tab
  // shows "none" rather than wrong data. Decide (below) is by id and is safe.
  router.get('/:scope/approvals', async (req, res) => {
    res.json({ ok: true, approvals: [], reason: 'approvals-list-by-scope-not-wired' });
  });

  router.post('/:scope/approvals/:id', async (req, res) => {
    const decision = (req.body || {}).decision;
    if (decision !== 'approve' && decision !== 'deny') {
      return res.status(400).json({ ok: false, error: "decision must be 'approve' or 'deny'" });
    }
    try {
      if (decision === 'approve') approvalsStore.approve(req.params.id, 'operator');
      else approvalsStore.deny(req.params.id, 'operator');
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // ── Jobs (cron) ─────────────────────────────────────────────────────────
  router.get('/:scope/cron', async (req, res) => {
    if (!cronService) return res.json({ ok: true, jobs: [], reason: 'cron-service-not-ready' });
    try {
      const jobs = cronService.list().filter((j) => j.agentId === req.params.scope);
      res.json({ ok: true, jobs });
    } catch (err) { fail(res, err); }
  });

  // Enable/disable needs the cron store's mutate-and-persist path; wire in a
  // follow-up. Run-now maps to the existing runNow.
  router.post('/:scope/cron/:id', async (req, res) => {
    res.status(501).json({ ok: false, error: 'cron-toggle-not-wired' });
  });

  router.post('/:scope/cron/:id/run', async (req, res) => {
    if (!cronService || typeof cronService.runNow !== 'function') {
      return res.status(503).json({ ok: false, error: 'cron-service-not-ready' });
    }
    try {
      await cronService.runNow(req.params.id);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // ── Files ─────────────────────────────────────────────────────────────────
  router.get('/:scope/files', async (req, res) => {
    try {
      const files = (await filesStore.listFiles(req.params.scope)).map((f) => ({
        id: f.key || f.filename,
        name: f.filename,
        sizeBytes: f.size || 0,
        createdAt: f.lastModified || null,
      }));
      res.json({ ok: true, files });
    } catch (err) {
      // Files store unconfigured is "nothing published", not an error.
      res.json({ ok: true, files: [], reason: err?.message });
    }
  });

  // ── Skills + Connected Apps (marketplace; vendor stub in OSS) ──────────────
  // getCatalog()/getInstalls() are GLOBAL (no scope arg) and empty in the OSS
  // build \u2014 the connector integration is vendor-specific. Read the real maps
  // when present, else report empty with a reason.
  router.get('/:scope/skills', async (req, res) => {
    try {
      const catalog = (marketplace.getCatalog && marketplace.getCatalog()) || {};
      const installs = (marketplace.getInstalls && marketplace.getInstalls()) || {};
      const skills = Object.entries(catalog.skills || {}).map(([id, s]) => ({
        id, name: s.name || id, description: s.description || '',
        installed: !!(installs.installs && installs.installs[id]),
        requiredCapability: s.capability || null,
      }));
      res.json({ ok: true, skills, reason: skills.length ? undefined : 'marketplace-empty' });
    } catch (err) { fail(res, err); }
  });

  router.get('/:scope/apps', async (req, res) => {
    try {
      const installs = (marketplace.getInstalls && marketplace.getInstalls()) || {};
      const apps = Object.entries(installs.connectors || {}).map(([id, c]) => ({
        id, name: c.name || id, connected: !!c.connected,
        toolPrefix: c.toolPrefix || null, capability: c.capability || null,
      }));
      res.json({ ok: true, apps, reason: apps.length ? undefined : 'marketplace-empty' });
    } catch (err) { fail(res, err); }
  });

  // ── Owners ─────────────────────────────────────────────────────────────────
  router.get('/:scope/owners', async (req, res) => {
    try {
      const map = (await owners.ownersOf(req.params.scope)) || {};
      const list = Object.entries(map).map(([id, meta]) => ({
        id,
        displayName: (meta && meta.displayName) || id,
        role: (meta && meta.role) || 'owner',
      }));
      res.json({ ok: true, owners: list });
    } catch (err) { fail(res, err); }
  });

  return { router };
}

module.exports = { createClientApi };
