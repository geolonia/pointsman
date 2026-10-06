// Probe (issue #41, docs/spikes/fiware-bridge.md): does an NGSI-LD broker
// send a notification for writes to attributes the subscription does not
// watch? Usage: node probe.mjs <label> <broker base URL> [tenant]
// Notifications go to http://$NOTIFY_HOST:8796/n/<label> (default
// host.containers.internal, for a broker in a container); WAIT_MS sets the
// wait after each step (default 4000).

import { createServer } from 'node:http';

const [label, base, tenant] = process.argv.slice(2);
if (!label || !base) {
  console.error('usage: node probe.mjs <label> <broker base URL> [tenant]');
  process.exit(2);
}
const PORT = 8796;
const HOST_FROM_CONTAINER = process.env.NOTIFY_HOST ?? 'host.containers.internal';
const run = Date.now().toString(36);
const type = `ProbeThing${run}`;
const id = `urn:ngsi-ld:${type}:1`;
const headers = { 'content-type': 'application/json', ...(tenant && { 'NGSILD-Tenant': tenant }) };

let count = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (new URL(req.url, "http://x").pathname === `/n/${label}`) count += 1;
    res.writeHead(200).end();
  });
});
await new Promise((r) => server.listen(PORT, '0.0.0.0', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 600) };
}

const results = [];
async function step(name, method, path, body) {
  const before = count;
  const r = await call(method, path, body);
  await sleep(Number(process.env.WAIT_MS ?? 4000));
  results.push({ step: name, status: r.status, notifications: count - before, ...(r.status >= 300 && { error: r.text }) });
}

try {
  const sub = await call('POST', '/ngsi-ld/v1/subscriptions', {
    id: `urn:ngsi-ld:Subscription:probe-${run}`,
    type: 'Subscription',
    entities: [{ type }],
    watchedAttributes: ['name'],
    notification: { endpoint: { uri: `http://${HOST_FROM_CONTAINER}:${PORT}/n/${label}`, accept: 'application/json' } },
  });
  if (sub.status !== 201) throw new Error(`subscription: ${sub.status} ${sub.text}`);
  await step('create entity (name, note)', 'POST', '/ngsi-ld/v1/entities', {
    id, type,
    name: { type: 'Property', value: 'first' },
    note: { type: 'Property', value: 'a' },
  });
  const e = encodeURIComponent(id);
  await step('PATCH /attrs: unwatched note', 'PATCH', `/ngsi-ld/v1/entities/${e}/attrs`, { note: { type: 'Property', value: 'b' } });
  await step('PATCH /attrs/note: unwatched, single attribute', 'PATCH', `/ngsi-ld/v1/entities/${e}/attrs/note`, { type: 'Property', value: 'c' });
  await step('POST /attrs: append unwatched extra', 'POST', `/ngsi-ld/v1/entities/${e}/attrs`, { extra: { type: 'Property', value: 1 } });
  await step('PATCH /attrs: unwatched with sub-properties', 'PATCH', `/ngsi-ld/v1/entities/${e}/attrs`, {
    note: { type: 'Property', value: 'd', model: { type: 'Property', value: 'm' }, profile: { type: 'Property', value: 'p' } },
  });
  await step('PATCH /attrs/note: unwatched with sub-properties', 'PATCH', `/ngsi-ld/v1/entities/${e}/attrs/note`, {
    type: 'Property', value: 'e', model: { type: 'Property', value: 'm2' }, profile: { type: 'Property', value: 'p2' },
  });
  await step('PATCH /attrs: unwatched note, same value again', 'PATCH', `/ngsi-ld/v1/entities/${e}/attrs`, { note: { type: 'Property', value: 'd' } });
  await step('PATCH /attrs: watched name (control)', 'PATCH', `/ngsi-ld/v1/entities/${e}/attrs`, { name: { type: 'Property', value: 'second' } });
  await call('DELETE', `/ngsi-ld/v1/entities/${e}`);
  await call('DELETE', `/ngsi-ld/v1/subscriptions/${encodeURIComponent(`urn:ngsi-ld:Subscription:probe-${run}`)}`);
} catch (err) {
  results.push({ step: 'error', error: String(err.message ?? err) });
}
server.close();
console.log(JSON.stringify({ broker: label, results }, null, 2));
