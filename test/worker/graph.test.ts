// The decision graph for DMN tools (src/graph.ts, GET /v1/profiles/{id}/graph).

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Deps } from '../../src/app';
import { hashToken, MemoryTokenStore, newToken } from '../../src/auth';
import { decisionGraph, layout, toDmn, toSvg } from '../../src/graph';
import { MockAdapter } from '../../src/models/mock';
import { MemoryProfileStore } from '../../src/profiles/store';
import type { Profile } from '../../src/types';
import bundled from '../../generated/profiles.json';
import { fakeLog, noCallbacks } from './helpers';
import * as contract from '../../generated/openapi-validators.mjs';

const all = bundled as Profile[];
const byId = (id: string) => all.find((p) => p.id === id)!;
const chain = ['road-closure-final', 'road-restriction-check', 'evacuation-access-check'];

describe('decisionGraph', () => {
  const g = decisionGraph(byId('road-closure-final'), all);

  it('has the chain as decisions, with information requirements by name', () => {
    expect(g.nodes.filter((n) => n.type === 'decision').map((n) => (n as { profile: string }).profile).sort()).toEqual([...chain].sort());
    const required = g.edges.filter((e) => e.type === 'informationRequirement' && e.to === 'decision_road-closure-final');
    expect(required.map((e) => [e.from, e.name, e.optional ?? false])).toEqual([
      ['decision_road-restriction-check', 'check', false],
      ['decision_evacuation-access-check', 'evacuation', true],
    ]);
    // Not connected to the chain: left out.
    expect(g.nodes.some((n) => n.id === 'decision_issue-triage')).toBe(false);
  });

  it('gives each decision its answers, inputs, AI model and data sources', () => {
    const check = g.nodes.find((n) => n.id === 'decision_road-restriction-check')!;
    expect(check).toMatchObject({ type: 'decision', allowedAnswers: expect.arrayContaining(['publish', 'review', 'urgent', 'reject']) });
    const final = g.nodes.find((n) => n.id === 'decision_road-closure-final')!;
    expect(final).toMatchObject({ model: 'none' });
    // A rules-only profile has no AI model and no state input.
    expect(g.edges.some((e) => e.to === final.id && e.type === 'knowledgeRequirement')).toBe(false);
    expect(g.edges.some((e) => e.type === 'knowledgeRequirement' && e.to === check.id)).toBe(true);
    const flood = g.nodes.find((n) => n.id === 'fact_road-restriction-check_flood');
    expect(flood).toMatchObject({ type: 'inputData', source: 'ks_gsi-flood-max' });
    expect(g.nodes.find((n) => n.id === 'ks_gsi-flood-max')).toMatchObject({ type: 'knowledgeSource', locationURI: 'https://disaportal.gsi.go.jp/' });
    expect(g.edges).toContainEqual(expect.objectContaining({ type: 'authorityRequirement', from: 'ks_gsi-flood-max', to: check.id }));
    // Each edge's ends are nodes; ids are NCNames.
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to), e.id).toBe(true);
    for (const id of [...ids, ...g.edges.map((e) => e.id)]) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9._-]*$/);
  });

  it('gives every node and edge its own id, also when a requirement is named like a fact or input', () => {
    const base = byId('road-closure-final');
    const odd = { ...base, facts: [{ name: 'x', type: 'inside', layer: 'gsi-flood-max', at: '$.location.value' }], requires: [...(base.requires ?? []), { name: 'fact_x', profile: 'issue-triage', optional: true }] } as Profile;
    const graph = decisionGraph(odd, all);
    const ids = [...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const xml = toDmn(graph);
    // Element ids (pm:profile and pm:model carry a profile or model id, not an XML id).
    const xmlIds = [...xml.matchAll(/<(?!pm:)[\w:]+ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(xmlIds).size).toBe(xmlIds.length);
  });

  it('is the same graph from any profile in it', () => {
    const fromCheck = decisionGraph(byId('road-restriction-check'), all);
    expect(fromCheck.nodes.map((n) => n.id).sort()).toEqual(g.nodes.map((n) => n.id).sort());
  });

  it('leaves out profiles the caller may not use', () => {
    const scoped = decisionGraph(byId('road-closure-final'), all.filter((p) => p.id !== 'evacuation-access-check'));
    expect(scoped.nodes.some((n) => n.id === 'decision_evacuation-access-check')).toBe(false);
    expect(scoped.edges.some((e) => e.from === 'decision_evacuation-access-check' || e.to === 'decision_evacuation-access-check')).toBe(false);
  });

  it('lays shapes out without overlaps, required decisions below the ones that require them', () => {
    const at = layout(g);
    const boxes = [...at.values()];
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    expect(at.get('decision_road-restriction-check')!.y).toBeGreaterThan(at.get('decision_road-closure-final')!.y);
  });
});

describe('toDmn', () => {
  const xml = toDmn(decisionGraph(byId('road-closure-final'), all));

  it('is DMN 1.3 with DMNDI', () => {
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<definitions xmlns="https:\/\/www.omg.org\/spec\/DMN\/20191111\/MODEL\/"/);
    expect(xml).toContain('xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/"');
    expect(xml).toContain('<pm:requirement name="evacuation" optional="true"/>');
    expect(xml).toContain('<pm:profile id="road-closure-final" version="1" model="none"/>');
  });

  it('refers only to elements it defines, and draws each of them', () => {
    const ids = new Set([...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const [, ref] of xml.matchAll(/href="#([^"]+)"/g)) expect(ids.has(ref), ref).toBe(true);
    const drawn = new Set([...xml.matchAll(/dmnElementRef="([^"]+)"/g)].map((m) => m[1]));
    for (const [, id] of xml.matchAll(/<(?:decision|inputData|businessKnowledgeModel|knowledgeSource) id="([^"]+)"/g)) expect(drawn.has(id), id).toBe(true);
    for (const [, id] of xml.matchAll(/<(?:informationRequirement|knowledgeRequirement|authorityRequirement) id="([^"]+)"/g)) expect(drawn.has(id), id).toBe(true);
  });

  it('drops characters XML does not allow', () => {
    const p = { ...byId('road-closure-final'), description: { en: 'a\u0001b\u000bc', ja: 'x' } } as Profile;
    expect(toDmn(decisionGraph(p, all))).toContain('<question>abc</question>');
  });

  it('escapes text', () => {
    const p = { ...byId('road-closure-final'), title: { en: 'A <b> & "c"', ja: 'x' } } as Profile;
    const out = toDmn(decisionGraph(p, all));
    expect(out).toContain('name="A &lt;b&gt; &amp; &quot;c&quot;"');
    expect(out).not.toContain('<b>');
  });
});

describe('toSvg', () => {
  const g = decisionGraph(byId('road-closure-final'), all);

  it('draws one box per decision in the datamodels.jp diagram style, the asked one highlighted', () => {
    const svg = toSvg(g, all, 'en');
    expect(svg).toMatch(/^<svg class="flow-diagram pm-graph" viewBox="0 0 \d+ \d+" role="img" aria-label="Road closure, final decision, made from: check, evacuation\."/);
    expect(svg.match(/<rect class="box/g)).toHaveLength(3);
    expect(svg.match(/<rect class="box main"/g)).toHaveLength(1);
    expect(svg).toContain('>Rules only, no AI<');
    expect(svg).toContain('>AI: 4 questions<');
    // The optional requirement is dashed and says so.
    expect(svg).toContain('class="a d"');
    expect(svg).toContain('>evacuation (if it ran)<');
    expect(svg).toContain('@media (prefers-color-scheme:dark)');
  });

  it('speaks Japanese with lang ja, and escapes text', () => {
    expect(toSvg(g, all, 'ja')).toContain('>通行止めの最終判断<');
    const odd = { ...byId('road-closure-final'), title: { en: '<script>', ja: 'x' } } as Profile;
    const svg = toSvg(decisionGraph(odd, all), [odd, ...all.filter((p) => p.id !== odd.id)], 'en');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('squeezes a title that would leave its box', () => {
    const long = { ...byId('road-closure-final'), title: { en: 'A very long title that does not fit into one box at all', ja: 'x' } } as Profile;
    expect(toSvg(decisionGraph(long, all), [long, ...all.filter((p) => p.id !== long.id)], 'en')).toContain('lengthAdjust="spacingAndGlyphs"');
  });
});

describe('GET /v1/profiles/{id}/graph', () => {
  const ALL = newToken();
  const FINAL_ONLY = newToken();
  const TEST = newToken();
  let call: (path: string, token?: string) => Promise<Response>;

  beforeEach(async () => {
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    tokens.records.set(await hashToken(FINAL_ONLY), { client: 'final', profiles: ['road-closure-final', 'road-restriction-check'], created_at: '' });
    tokens.records.set(await hashToken(TEST), { client: 'checks', profiles: ['*'], created_at: '', test: true });
    const deps: Deps = { store: new MemoryProfileStore(all), tokens, log: fakeLog(), adapterFor: () => new MockAdapter(), callbacks: noCallbacks };
    const app = createApp(() => deps);
    call = async (path, token = ALL) => app.request(path, { headers: { authorization: `Bearer ${token}` } }, env);
  });

  it('answers the graph as JSON, and as DMN XML with format=dmn', async () => {
    const json = await call('/v1/profiles/road-closure-final/graph');
    expect(json.status).toBe(200);
    const g = await json.json<{ profile: string; nodes: unknown[] }>();
    expect(g.profile).toBe('road-closure-final');
    expect(contract.decisionGraph(g), JSON.stringify(contract.decisionGraph.errors)).toBe(true);
    const dmn = await call('/v1/profiles/road-closure-final/graph?format=dmn');
    expect(dmn.status).toBe(200);
    expect(dmn.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(dmn.headers.get('content-disposition')).toBe('inline; filename="road-closure-final.dmn"');
    expect(await dmn.text()).toContain('<dmndi:DMNDiagram');
    const svg = await call('/v1/profiles/road-closure-final/graph?format=svg&lang=ja');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(await svg.text()).toContain('通行止めの最終判断');
  });

  it('reads only the profiles connected to it, by the index', async () => {
    const read: string[] = [];
    const store = new MemoryProfileStore(all);
    const counting = { list: () => store.list(), get: async (id: string, v?: number) => { read.push(id); return store.get(id, v); } };
    const tokens = new MemoryTokenStore();
    tokens.records.set(await hashToken(ALL), { client: 'all', profiles: ['*'], created_at: '' });
    const app = createApp(() => ({ store: counting, tokens, log: fakeLog(), adapterFor: () => new MockAdapter(), callbacks: noCallbacks }));
    const res = await app.request('/v1/profiles/road-closure-final/graph', { headers: { authorization: `Bearer ${ALL}` } }, env);
    expect(res.status).toBe(200);
    expect([...new Set(read)].sort()).toEqual([...chain].sort());
    // An index from before (no requires): every profile in scope, as a fallback.
    read.length = 0;
    counting.list = async () => (await store.list()).map(({ requires: _, ...s }) => s);
    await app.request('/v1/profiles/road-closure-final/graph', { headers: { authorization: `Bearer ${ALL}` } }, env);
    expect(new Set(read).size).toBe(all.length);
  });

  it('shows only profiles in the token scope', async () => {
    const g = await (await call('/v1/profiles/road-closure-final/graph', FINAL_ONLY)).json<{ nodes: { id: string }[] }>();
    expect(g.nodes.map((n) => n.id)).not.toContain('decision_evacuation-access-check');
    expect(g.nodes.map((n) => n.id)).toContain('decision_road-restriction-check');
  });

  it('refuses profiles out of scope (before the lookup), unknown ones, a bad format and test tokens', async () => {
    expect((await call('/v1/profiles/evacuation-access-check/graph', FINAL_ONLY)).status).toBe(403);
    expect((await call('/v1/profiles/no-such-profile/graph', FINAL_ONLY)).status).toBe(403);
    expect((await call('/v1/profiles/no-such-profile/graph')).status).toBe(404);
    expect((await call('/v1/profiles/road-closure-final/graph?format=png')).status).toBe(400);
    expect((await call('/v1/profiles/road-closure-final/graph?format=svg&lang=fr')).status).toBe(400);
    expect((await call('/v1/profiles/road-closure-final/graph', TEST)).status).toBe(403);
  });
});
