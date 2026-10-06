// Spike code (docs/spikes/fiware-bridge.md, issue #14); not used by the engine.
// NGSI-LD subscription -> bridge Worker -> Pointsman -> PATCH back.
//
// The broker sends a notification for each changed entity. The bridge asks
// the profile configured for the entity type, with the entity as the raw
// payload (the profile's input paths read the normalized entity), and writes
// the result back as one Property on the entity. The subscription watches
// only the input attributes. The write uses the single-attribute update, which
// no tested broker turns into a notification, and an input hash guards
// against loops with any other broker (see inputHash).

const ROUTES = {
  // entity type -> profile, the attributes it reads, and the attribute the
  // result is written to
  ServiceRequest: { profile: 'service-request-triage', inputs: ['name', 'description'], attribute: 'triage' },
};

// Hash of the input attributes' values. Stored with the result; a
// notification whose inputs have this hash already has its decision. This is
// the loop guard: brokers may notify on the bridge's own write even when the
// subscription watches other attributes.
async function inputHash(entity, inputs) {
  const values = inputs.map((name) => entity[name]?.value ?? null);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/notify') return new Response('not found', { status: 404 });
    // The subscription sends this header (endpoint.receiverInfo).
    if (request.headers.get('x-bridge-secret') !== env.NOTIFY_SECRET) return new Response('forbidden', { status: 403 });

    const notification = await request.json();
    const results = [];
    for (const entity of notification.data ?? []) {
      const route = ROUTES[entity.type];
      if (!route) continue;
      // One entity's failure must not stop the others in the notification.
      try {
        results.push(await handle(entity, route, env));
      } catch (err) {
        results.push({ id: entity.id, error: String(err) });
      }
    }
    // Any failure: answer 502 so a broker that retries notifications sends it
    // again. Entities that succeeded are skipped on the retry (input hash), so
    // a retry repeats only the failed ones.
    const failed = results.some((r) => r.error);
    return Response.json({ handled: results }, { status: failed ? 502 : 200 });
  },
};

async function handle(entity, route, env) {
  const hash = await inputHash(entity, route.inputs);
  if (entity[route.attribute]?.inputHash?.value === hash) return { id: entity.id, skipped: 'inputs unchanged' };
  const res = await fetch(`${env.POINTSMAN_URL}/v1/decide/${route.profile}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.POINTSMAN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: entity, ref: entity.id }),
  });
  if (!res.ok) return { id: entity.id, error: `pointsman ${res.status}: ${await res.text()}` };
  const d = await res.json();
  if (!d || typeof d.action !== 'string' || !d.answers || typeof d.answers !== 'object') {
    return { id: entity.id, error: 'unexpected response from pointsman' };
  }

  // One Property: the action as value, the rest as sub-properties
  // (Property of Property), so a consumer that only needs the action reads
  // triage.value, and the evidence stays next to it.
  const property = {
    type: 'Property',
    value: d.action,
    observedAt: d.created_at ?? new Date().toISOString(),
    decisionId: { type: 'Property', value: d.decision_id },
    profile: { type: 'Property', value: d.profile },
    profileVersion: { type: 'Property', value: d.profile_version },
    model: { type: 'Property', value: d.model },
    inputHash: { type: 'Property', value: hash },
  };
  for (const [name, a] of Object.entries(d.answers)) {
    // Sub-properties are one level deep: Orion-LD drops a third level.
    property[name] = { type: 'Property', value: a.value };
    property[`${name}Probability`] = { type: 'Property', value: a.p };
  }

  // Update just this attribute (PATCH .../attrs/{name}). Orion-LD notifies
  // subscriptions on the multi-attribute PATCH .../attrs even when only
  // unwatched attributes change, which loops through the bridge (#41); the
  // single-attribute update does not. The first time, the attribute does not
  // exist yet (404), so it is appended with POST .../attrs.
  const attrs = `${env.BROKER_URL}/ngsi-ld/v1/entities/${encodeURIComponent(entity.id)}/attrs`;
  let write = await fetch(`${attrs}/${encodeURIComponent(route.attribute)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(property),
  });
  if (write.status === 404) {
    write = await fetch(attrs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [route.attribute]: property }),
    });
  }
  // Without a successful write the input hash is not stored either, so the
  // next notification decides again: report it as a failure.
  if (!write.ok) {
    return { id: entity.id, decision: d.decision_id, error: `broker write failed: ${write.status} ${await write.text()}` };
  }
  return { id: entity.id, action: d.action, decision: d.decision_id, write: write.status };
}
