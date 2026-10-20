// The decision graph of a profile for DMN tools (docs/decision-chains.md, "The
// graph for DMN tools"): the profile, the profiles it requires and the ones
// that require it, as a DMN decision requirements graph. JSON whose nodes and
// edges use the DMN names, and DMN 1.3 XML with DMNDI (a layered layout), so
// that bpmn.io dmn-js, Camunda Modeler, Apache KIE and Trisotech open it.
// Only the graph: Pointsman does not run DMN decision logic.

import { peopleAnswers, profileActions } from './policy';
import type { FactSpec, Profile } from './types';

export type GraphNode =
  | {
      id: string;
      type: 'decision';
      name: string;
      profile: string;
      version: number;
      question: string;
      allowedAnswers: string[];
      /** The profile's model, or none for a rules-only profile. */
      model: string;
    }
  /** A state field, or a fact (then `source`: the knowledge source it is looked up from). */
  | { id: string; type: 'inputData'; name: string; source?: string }
  | { id: string; type: 'businessKnowledgeModel'; name: string; profile: string; model: string }
  | { id: string; type: 'knowledgeSource'; name: string; locationURI?: string };

export interface GraphEdge {
  id: string;
  type: 'informationRequirement' | 'knowledgeRequirement' | 'authorityRequirement';
  from: string;
  to: string;
  /** For a required decision: the name the requiring profile gives it. */
  name?: string;
  /** For a required decision: it may not exist (requires … optional). */
  optional?: boolean;
}

export interface DecisionGraph {
  /** The profile the graph was asked for. */
  profile: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The data behind the facts, by layer (and detour routing). */
const SOURCES: Record<string, { name: string; locationURI?: string }> = {
  'gsi-flood-max': { name: 'GSI hazard map portal: river flood zones (maximum assumed rainfall)', locationURI: 'https://disaportal.gsi.go.jp/' },
  'gsi-shelters-flood': { name: 'GSI designated emergency evacuation sites (flood)', locationURI: 'https://www.gsi.go.jp/bousaichiri/hinanbasho.html' },
  routing: { name: 'OpenStreetMap, routed with Valhalla', locationURI: 'https://www.openstreetmap.org/copyright' },
};

/** An NCName for DMN ids: letters, digits, `.`, `-`, `_`, not starting with a digit, `.` or `-`. */
function ncname(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '_');
}

const sourceKey = (f: FactSpec) => (f.type === 'detour' ? 'routing' : f.layer ?? f.type);

/**
 * The graph `profile` belongs to: the profiles connected to it through
 * `requires`, in both directions, among `profiles` (the ones the caller may
 * use; others are left out, as if they did not exist).
 */
export function decisionGraph(profile: Profile, profiles: Profile[]): DecisionGraph {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  byId.set(profile.id, profile);
  // Connected profiles: follow requires down and up.
  const members = new Map<string, Profile>([[profile.id, profile]]);
  const queue = [profile];
  while (queue.length > 0) {
    const p = queue.shift()!;
    const linked = [
      ...(p.requires ?? []).map((r) => byId.get(r.profile)),
      ...[...byId.values()].filter((q) => (q.requires ?? []).some((r) => r.profile === p.id)),
    ];
    for (const q of linked) {
      if (q && !members.has(q.id)) {
        members.set(q.id, q);
        queue.push(q);
      }
    }
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (n: GraphNode) => {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      nodes.push(n);
    }
  };
  const decisionId = (id: string) => `decision_${ncname(id)}`;
  // Sorted, so the same profiles always give the same graph.
  const ordered = [...members.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const p of ordered) {
    const id = decisionId(p.id);
    const answers = [...new Set([...profileActions(p), ...peopleAnswers(p)])];
    add({ id, type: 'decision', name: p.title.en, profile: p.id, version: p.version, question: p.description.en, allowedAnswers: answers, model: p.model });
    for (const r of p.requires ?? []) {
      if (!members.has(r.profile)) continue;
      // One prefix per kind of edge: a requirement named like an input or a fact cannot clash.
      edges.push({ id: `ird_${ncname(p.id)}_${ncname(r.name)}`, type: 'informationRequirement', from: decisionId(r.profile), to: id, name: r.name, ...(r.optional && { optional: true }) });
    }
    // The state's fields the profile reads (shared by name across profiles).
    const inputs = p.input?.map((i) => i.name) ?? (p.questions.length > 0 ? ['state'] : []);
    for (const name of inputs) {
      const inputId = `input_${ncname(name)}`;
      add({ id: inputId, type: 'inputData', name });
      edges.push({ id: `iri_${ncname(p.id)}_${ncname(name)}`, type: 'informationRequirement', from: inputId, to: id });
    }
    // Each fact is an input of its own, looked up from a data source.
    for (const f of p.facts ?? []) {
      const factId = `fact_${ncname(p.id)}_${ncname(f.name)}`;
      add({ id: factId, type: 'inputData', name: f.name, source: `ks_${ncname(sourceKey(f))}` });
      edges.push({ id: `irf_${ncname(p.id)}_${ncname(f.name)}`, type: 'informationRequirement', from: factId, to: id });
      const key = sourceKey(f);
      const ksId = `ks_${ncname(key)}`;
      add({ id: ksId, type: 'knowledgeSource', ...(SOURCES[key] ?? { name: key }) });
      const authority = `ar_${ncname(p.id)}_${ncname(key)}`;
      if (!edges.some((e) => e.id === authority)) edges.push({ id: authority, type: 'authorityRequirement', from: ksId, to: id });
    }
    // The AI questions: an analytic model, exported without its logic.
    if (p.questions.length > 0) {
      const bkmId = `bkm_${ncname(p.id)}`;
      add({ id: bkmId, type: 'businessKnowledgeModel', name: `AI questions (${p.questions.map((q) => q.name).join(', ')})`, profile: p.id, model: p.model });
      edges.push({ id: `kr_${ncname(p.id)}`, type: 'knowledgeRequirement', from: bkmId, to: id });
    }
  }
  return { profile: profile.id, nodes, edges };
}

// --- DMN 1.3 XML ------------------------------------------------------------

const DMN = 'https://www.omg.org/spec/DMN/20191111/MODEL/';
const DMNDI = 'https://www.omg.org/spec/DMN/20191111/DMNDI/';
const DC = 'http://www.omg.org/spec/DMN/20180521/DC/';
const DI = 'http://www.omg.org/spec/DMN/20180521/DI/';
/** Pointsman's own extension elements (profile version, requirement name and optional). */
export const PM_NS = 'https://github.com/geolonia/pointsman/dmn';

/** Shape sizes: decisions larger than their inputs, models and sources. */
const SIZE: Record<GraphNode['type'], { w: number; h: number }> = {
  decision: { w: 220, h: 80 },
  inputData: { w: 140, h: 50 },
  businessKnowledgeModel: { w: 180, h: 60 },
  knowledgeSource: { w: 180, h: 70 },
};
const ROW = 80;
const GAP_X = 30;
const GAP_Y = 70;

function xml(text: string): string {
  // Characters XML 1.0 does not allow are dropped, so the document stays well-formed.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A tree layout, top to bottom: the decisions nothing requires on top; under
 * each decision the decisions it requires, its inputs and its AI model; under
 * each fact the data source it is looked up from. A node shared by two
 * decisions sits under the first; its other edges cross over.
 */
export function layout(graph: DecisionGraph): Map<string, { x: number; y: number; w: number; h: number }> {
  const size = (id: string) => SIZE[graph.nodes.find((n) => n.id === id)!.type];
  const kids = new Map<string, string[]>();
  const placed = new Set<string>();
  const child = (parent: string, id: string) => {
    if (placed.has(id)) return;
    placed.add(id);
    kids.set(parent, [...(kids.get(parent) ?? []), id]);
  };
  const decisions = graph.nodes.filter((n) => n.type === 'decision').map((n) => n.id);
  const roots = decisions.filter((d) => !graph.edges.some((e) => e.type === 'informationRequirement' && e.from === d));
  roots.forEach((r) => placed.add(r));
  // Breadth first from the roots, so a shared node sits under the decision closest to the top.
  const queue = [...roots];
  while (queue.length > 0) {
    const d = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.to === d && x.type !== 'authorityRequirement')) {
      if (!placed.has(e.from) && decisions.includes(e.from)) queue.push(e.from);
      child(d, e.from);
    }
  }
  // Sources under the first fact that uses them; a source without one under its decision.
  for (const n of graph.nodes) if (n.type === 'inputData' && n.source) child(n.id, n.source);
  for (const e of graph.edges.filter((x) => x.type === 'authorityRequirement')) child(e.to, e.from);
  // Anything left (should not happen) joins the roots.
  for (const n of graph.nodes) if (!placed.has(n.id)) { placed.add(n.id); roots.push(n.id); }

  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  const place = (id: string, depth: number, left: number): number => {
    const { w, h } = size(id);
    const below = kids.get(id) ?? [];
    let x = left;
    for (const k of below) x += place(k, depth + 1, x) + GAP_X;
    const span = below.length > 0 ? x - GAP_X - left : 0;
    const width = Math.max(w, span);
    // Each row has the height of a decision; smaller shapes sit centred in it.
    out.set(id, { x: left + (width - w) / 2, y: 20 + depth * (ROW + GAP_Y) + (ROW - h) / 2, w, h });
    // Children narrower than the node: centre them under it.
    if (below.length > 0 && span < w) shift(below, (w - span) / 2);
    return width;
  };
  const shift = (ids: string[], dx: number) => {
    for (const k of ids) {
      const p = out.get(k)!;
      out.set(k, { ...p, x: p.x + dx });
      shift(kids.get(k) ?? [], dx);
    }
  };
  let left = 20;
  for (const r of roots) left += place(r, 0, left) + GAP_X;
  return out;
}

/** The graph as DMN 1.3 XML: the decision requirements diagram, with DMNDI. */
export function toDmn(graph: DecisionGraph): string {
  const at = layout(graph);
  const into = (id: string, type: GraphEdge['type']) => graph.edges.filter((e) => e.to === id && e.type === type);
  const kind = (id: string) => graph.nodes.find((n) => n.id === id)!.type;
  const lines: string[] = [];
  const top = graph.nodes.find((n) => n.type === 'decision' && n.profile === graph.profile)!;
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<definitions xmlns="${DMN}" xmlns:dmndi="${DMNDI}" xmlns:dc="${DC}" xmlns:di="${DI}" xmlns:pm="${PM_NS}"`
    + ` id="definitions_${ncname(graph.profile)}" name="${xml(top.name)}" namespace="${PM_NS}/profiles/${xml(graph.profile)}"`
    + ' exporter="Pointsman" exporterVersion="1">');
  for (const n of graph.nodes) {
    if (n.type === 'decision') {
      lines.push(`  <decision id="${n.id}" name="${xml(n.name)}">`);
      lines.push(`    <extensionElements><pm:profile id="${xml(n.profile)}" version="${n.version}" model="${xml(n.model)}"/></extensionElements>`);
      lines.push(`    <question>${xml(n.question)}</question>`);
      lines.push(`    <allowedAnswers>${xml(n.allowedAnswers.join(', '))}</allowedAnswers>`);
      for (const e of into(n.id, 'informationRequirement')) {
        const ext = e.name !== undefined
          ? `<extensionElements><pm:requirement name="${xml(e.name)}"${e.optional ? ' optional="true"' : ''}/></extensionElements>`
          : '';
        const ref = kind(e.from) === 'decision' ? 'requiredDecision' : 'requiredInput';
        lines.push(`    <informationRequirement id="${e.id}">${ext}<${ref} href="#${e.from}"/></informationRequirement>`);
      }
      for (const e of into(n.id, 'knowledgeRequirement')) {
        lines.push(`    <knowledgeRequirement id="${e.id}"><requiredKnowledge href="#${e.from}"/></knowledgeRequirement>`);
      }
      for (const e of into(n.id, 'authorityRequirement')) {
        lines.push(`    <authorityRequirement id="${e.id}"><requiredAuthority href="#${e.from}"/></authorityRequirement>`);
      }
      lines.push('  </decision>');
    } else if (n.type === 'inputData') {
      lines.push(`  <inputData id="${n.id}" name="${xml(n.name)}"/>`);
    } else if (n.type === 'businessKnowledgeModel') {
      lines.push(`  <businessKnowledgeModel id="${n.id}" name="${xml(n.name)}">`);
      lines.push(`    <extensionElements><pm:model id="${xml(n.model)}"/></extensionElements>`);
      lines.push('  </businessKnowledgeModel>');
    } else {
      lines.push(`  <knowledgeSource id="${n.id}" name="${xml(n.name)}"${n.locationURI ? ` locationURI="${xml(n.locationURI)}"` : ''}/>`);
    }
  }
  lines.push('  <dmndi:DMNDI>');
  lines.push(`    <dmndi:DMNDiagram id="diagram_${ncname(graph.profile)}">`);
  for (const n of graph.nodes) {
    const p = at.get(n.id)!;
    lines.push(`      <dmndi:DMNShape id="shape_${n.id}" dmnElementRef="${n.id}"><dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/></dmndi:DMNShape>`);
  }
  for (const e of graph.edges) {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    // From the top of the source to the bottom of the target (sources are below).
    lines.push(`      <dmndi:DMNEdge id="edge_${e.id}" dmnElementRef="${e.id}"><di:waypoint x="${a.x + a.w / 2}" y="${a.y}"/><di:waypoint x="${b.x + b.w / 2}" y="${b.y + b.h}"/></dmndi:DMNEdge>`);
  }
  lines.push('    </dmndi:DMNDiagram>');
  lines.push('  </dmndi:DMNDI>');
  lines.push('</definitions>');
  return `${lines.join('\n')}\n`;
}

// --- SVG, in the style of the datamodels.jp diagrams --------------------------

/** Words of the SVG, by language. */
const SVG_TEXT = {
  en: { ai: (n: number) => `AI: ${n} question${n === 1 ? '' : 's'}`, rules: 'Rules only, no AI', map: 'Map: ', optional: ' (if it ran)', aria: (top: string, req: string[]) => `${top}${req.length ? `, made from: ${req.join(', ')}` : ''}.` },
  ja: { ai: (n: number) => `AI：${n} 問`, rules: '規則だけ（AI なし）', map: '地図：', optional: '（あれば）', aria: (top: string, req: string[]) => `${top}${req.length ? `。もとにする判断：${req.join('、')}` : ''}。` },
};

/** Rough text width in px: CJK twice as wide as Latin. */
function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[　-鿿＀-￯]/.test(ch) ? size : size * 0.56;
  return w;
}

/** A text line that never leaves its box: squeezed when it is too long. */
function svgText(cls: string, x: number, y: number, text: string, size: number, max: number): string {
  const fit = textWidth(text, size) > max ? ` textLength="${max}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text class="${cls}" x="${x}" y="${y}"${fit}>${xml(text)}</text>`;
}

/**
 * The chain as a small SVG diagram in the datamodels.jp flow-diagram style
 * (class names and colours), as a flow from left to right: one box per
 * decision with its AI questions and map checks, each decision one column
 * right of the decisions it requires, the asked-for decision highlighted.
 * Arrows go from each required decision, labelled with its name; one that
 * skips a column runs under the boxes. Inline on datamodels.jp it takes the
 * site's CSS; on its own it uses the colours in its style element (light
 * and dark).
 */
export function toSvg(graph: DecisionGraph, profiles: Profile[], lang: 'en' | 'ja' = 'en'): string {
  const words = SVG_TEXT[lang];
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const decisions = graph.nodes.filter((n): n is Extract<GraphNode, { type: 'decision' }> => n.type === 'decision');
  const reqEdges = graph.edges.filter((e) => e.type === 'informationRequirement' && e.from.startsWith('decision_'));
  // Columns: decisions that require none on the left; each decision one
  // column right of the rightmost decision it requires.
  const col = new Map<string, number>();
  const column = (id: string, guard = 0): number => {
    if (col.has(id)) return col.get(id)!;
    const from = reqEdges.filter((e) => e.to === id).map((e) => e.from);
    const c = from.length === 0 || guard > decisions.length ? 0 : Math.max(...from.map((f) => column(f, guard + 1))) + 1;
    col.set(id, c);
    return c;
  };
  for (const d of decisions) column(d.id);
  const sparse: string[][] = [];
  for (const d of decisions) (sparse[col.get(d.id)!] ??= []).push(d.id);
  // No empty columns (only a cycle, which validation refuses, could leave one).
  const cols = sparse.filter((c) => c && c.length > 0);
  cols.forEach((ids, c) => ids.forEach((id) => col.set(id, c)));
  const BW = 200;
  const BH = 78;
  const GX = 110;
  const GY = 24;
  /** Space under the boxes for each arrow that skips a column. */
  const LANE = 34;
  const tallest = Math.max(...cols.map((c) => c.length));
  const boxes = tallest * BH + (tallest - 1) * GY;
  const width = Math.max(460, 40 + cols.length * BW + (cols.length - 1) * GX);
  // Centred when the drawing is narrower than the image (a single decision).
  const left = (width - (cols.length * BW + (cols.length - 1) * GX)) / 2;
  const at = new Map<string, { x: number; y: number }>();
  cols.forEach((ids, c) => {
    const span = ids.length * BH + (ids.length - 1) * GY;
    ids.forEach((id, i) => at.set(id, { x: left + c * (BW + GX), y: 8 + (boxes - span) / 2 + i * (BH + GY) }));
  });
  const skips = reqEdges.filter((e) => col.get(e.to)! - col.get(e.from)! > 1);
  /** Whether another box sits below this one in its column (an arrow straight down would run behind it). */
  const boxBelow = (id: string) => cols[col.get(id)!]!.some((o) => o !== id && at.get(o)!.y > at.get(id)!.y);
  const height = 8 + boxes + (skips.length > 0 ? 12 + skips.length * LANE : 0) + 8;
  const top = decisions.find((d) => d.profile === graph.profile)!;
  const title = (d: typeof top) => byId.get(d.profile)?.title[lang] ?? d.name;
  const parts: string[] = [];
  const mid = `pm-ah-${ncname(graph.profile)}`;
  parts.push(`<svg class="flow-diagram pm-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(words.aria(title(top), reqEdges.filter((e) => e.to === top.id).map((e) => e.name ?? '')))}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push('<style>'
    + '.pm-graph{--pm-bg:#f1ece2;--pm-line:#e4ddd0;--pm-brand:#c8321f;--pm-text:#3c3a36;--pm-text2:#67635c;--pm-text3:#98938a;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}'
    + '@media (prefers-color-scheme:dark){.pm-graph{--pm-bg:#2a2521;--pm-line:#332e29;--pm-brand:#e5543f;--pm-text:#ece6dc;--pm-text2:#b8b1a6;--pm-text3:#857f75}}'
    + '.pm-graph .box{fill:var(--vp-c-bg-soft,var(--pm-bg));stroke:var(--vp-c-divider,var(--pm-line));stroke-width:1.5}'
    + '.pm-graph .box.main{stroke:var(--vp-c-brand-1,var(--pm-brand));stroke-width:2}'
    + '.pm-graph text{text-anchor:middle;fill:var(--vp-c-text-1,var(--pm-text))}'
    + '.pm-graph .t{font-size:15px;font-weight:600}.pm-graph .s{font-size:12.5px;fill:var(--vp-c-text-2,var(--pm-text2))}'
    + '.pm-graph .l{font-size:12.5px;fill:var(--vp-c-text-2,var(--pm-text2))}'
    + '.pm-graph .a{fill:none;stroke:var(--vp-c-text-3,var(--pm-text3));stroke-width:1.5;stroke-linejoin:round}.pm-graph .a.d{stroke-dasharray:4 3}'
    + '.pm-graph .ah{fill:var(--vp-c-text-3,var(--pm-text3))}'
    + '</style>');
  parts.push(`<defs><marker id="${mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ah"/></marker></defs>`);
  // Where arrows meet a box side by side, so they do not meet in one point.
  const spread = (k: number, n: number, length: number) => (length * (k + 1)) / (n + 1);
  // Arrows first, so boxes sit on top of their ends.
  for (const e of reqEdges) {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    const label = e.name ?? '';
    const skip = skips.indexOf(e);
    if (skip < 0) {
      // Next column: from the right side of one box to the left side of the next.
      const outs = reqEdges.filter((x) => x.from === e.from && !skips.includes(x)).sort((p, q) => at.get(p.to)!.y - at.get(q.to)!.y);
      const ins = reqEdges.filter((x) => x.to === e.to && !skips.includes(x)).sort((p, q) => at.get(p.from)!.y - at.get(q.from)!.y);
      const x1 = a.x + BW + 2;
      const y1 = a.y + spread(outs.indexOf(e), outs.length, BH);
      const x2 = b.x - 2;
      const y2 = b.y + spread(ins.indexOf(e), ins.length, BH);
      parts.push(`<path class="a${e.optional ? ' d' : ''}" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#${mid})"/>`);
      // The name above the arrow's middle, "(if it ran)" under it.
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      parts.push(svgText('l', mx, my - 7, label, 12.5, GX - 14));
      if (e.optional) parts.push(svgText('l', mx, my + 17, words.optional.trim(), 12.5, GX - 14));
    } else {
      // Skips a column: down from the box, under the boxes, up into the other.
      const ins = reqEdges.filter((x) => x.to === e.to && skips.includes(x)).sort((p, q) => at.get(p.from)!.x - at.get(q.from)!.x);
      const outs = skips.filter((x) => x.from === e.from).sort((p, q) => at.get(p.to)!.x - at.get(q.to)!.x);
      const lane = 8 + boxes + 12 + skip * LANE + 8;
      // Down from the box's bottom, or, with a box below it, out of its right
      // side and down through the gap next to the column; the same way up
      // into the target (its left side, through the gap before its column).
      let start: string;
      let x1: number;
      // In the gap, never back into a box, a few px apart for each arrow.
      const inGap = (k: number) => Math.min(GX - 12, 12 + (k % 8) * 8);
      if (boxBelow(e.from)) {
        x1 = a.x + BW + inGap(skip);
        const y = a.y + BH - 10 - (outs.indexOf(e) % 6) * 6;
        start = `M${a.x + BW + 2} ${y} L${x1} ${y}`;
      } else {
        x1 = a.x + spread(outs.indexOf(e), outs.length, BW);
        start = `M${x1} ${a.y + BH + 2}`;
      }
      let end: string;
      let x2: number;
      if (boxBelow(e.to)) {
        x2 = b.x - inGap(skip);
        const y = b.y + BH - 10 - (ins.indexOf(e) % 6) * 6;
        end = `L${x2} ${y} L${b.x - 2} ${y}`;
      } else {
        x2 = b.x + spread(ins.indexOf(e), ins.length, BW);
        end = `L${x2} ${b.y + BH + 2}`;
      }
      parts.push(`<path class="a${e.optional ? ' d' : ''}" d="${start} L${x1} ${lane} L${x2} ${lane} ${end}" marker-end="url(#${mid})"/>`);
      parts.push(svgText('l', (x1 + x2) / 2, lane - 6, `${label}${e.optional ? words.optional : ''}`, 12.5, Math.abs(x2 - x1) - 20));
    }
  }
  for (const d of decisions) {
    const { x, y } = at.get(d.id)!;
    const p = byId.get(d.profile);
    const questions = p?.questions.length ?? 0;
    const facts = (p?.facts ?? []).map((f) => f.name);
    const line1 = questions > 0 ? words.ai(questions) : words.rules;
    const line2 = facts.length > 0 ? words.map + facts.join(', ') : `${d.profile} v${d.version}`;
    parts.push(`<rect class="box${d.id === top.id ? ' main' : ''}" x="${x}" y="${y}" width="${BW}" height="${BH}" rx="10"/>`);
    parts.push(svgText('t', x + BW / 2, y + 26, title(d), 15, BW - 16));
    parts.push(svgText('s', x + BW / 2, y + 47, line1, 12.5, BW - 16));
    parts.push(svgText('s', x + BW / 2, y + 65, line2, 12.5, BW - 16));
  }
  parts.push('</svg>');
  return `${parts.join('')}\n`;
}
