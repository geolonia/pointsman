// The FIWARE bridge's routes (bridge.ts): one per entity type and profile,
// and the check of BRIDGE_ROUTES (bridge/README.md).

/** One entity type the bridge handles. */
export interface Route {
  /** Entity type as it appears in the notification. */
  type: string;
  /** Pointsman profile to call. */
  profile: string;
  /** The attributes the profile reads; the loop guard hashes their values. */
  inputs: string[];
  /** The attribute the result is written to. */
  attribute: string;
  /** Also create a Decision entity (datamodels.jp Decision model) for each decision. */
  decisionEntity?: boolean;
  /** More actions a person checks before anything happens, besides those Pointsman opens a review for (the profile's people_check). */
  reviewActions?: string[];
  /**
   * Needed when a type has more than one route: the subscription for this
   * route notifies `/notify?route=<name>`. A route without a name serves
   * `/notify` for its type.
   */
  name?: string;
  /**
   * For a chain of decisions: an input attribute written by an earlier
   * route. Its `decision` relationship becomes this decision's
   * `wasInformedBy` in the Decision entity.
   */
  informedBy?: string;
  /**
   * For a decision chain (docs/decision-chains.md): the earlier decisions the
   * profile `requires`, by its names, each read from an input attribute that
   * an earlier route wrote. The bridge sends their `decisionId` in
   * `decisions`. Routes with requires run from the queue only.
   */
  requires?: Record<string, Requirement>;
  /**
   * Also create a Task entity (datamodels.jp Task model) for these actions
   * and for every decision Pointsman opens a review for, so a person's work
   * shows up in any app that lists tasks. See TaskOptions.
   */
  task?: TaskOptions;
}

export interface Requirement {
  /** The input attribute with the earlier decision's result. */
  attribute: string;
  /**
   * Run again when a person resolves that decision's review (its result gets
   * finalAction and reviewedAt). Default false: only a new decision runs it again.
   */
  rerunOnReview?: boolean;
  /** The decision may not come; the route then runs without it. Default false: the route waits for it. */
  optional?: boolean;
}

export interface TaskOptions {
  /** The actions that create a Task, for example ["review", "urgent"]. */
  actions: string[];
  /** An attribute whose text goes into the Task's name (for example a road name). */
  name?: string;
  /** Priority per action, 1 (highest) to 9 (lowest), as in RFC 8984. Other actions get none. */
  priority?: Record<string, number>;
}

/** Checks a configuration from JSON (for example a Worker variable). */
export function parseRoutes(json: string): Route[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('bridge routes: not valid JSON');
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error('bridge routes: expected a non-empty list');
  const seen = new Set<string>();
  const routes = data.map((r, i): Route => {
    const where = `bridge routes[${i}]`;
    if (!r || typeof r !== 'object') throw new Error(`${where}: expected an object`);
    const { type, profile, inputs, attribute, decisionEntity, reviewActions, name, informedBy, task, requires } = r as Record<string, unknown>;
    for (const [name, v] of Object.entries({ type, profile, attribute })) {
      if (typeof v !== 'string' || v === '') throw new Error(`${where}.${name}: expected a non-empty string`);
    }
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((x) => typeof x === 'string' && x !== '')) {
      throw new Error(`${where}.inputs: expected a non-empty list of attribute names`);
    }
    // Writing to an input would change the inputs and start a new decision.
    if ((inputs as string[]).includes(attribute as string)) throw new Error(`${where}: attribute must not be one of the inputs`);
    if (decisionEntity !== undefined && typeof decisionEntity !== 'boolean') throw new Error(`${where}.decisionEntity: expected true or false`);
    if (reviewActions !== undefined && (!Array.isArray(reviewActions) || !reviewActions.every((x) => typeof x === 'string' && x !== ''))) {
      throw new Error(`${where}.reviewActions: expected a list of action names`);
    }
    if (name !== undefined && (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name))) {
      throw new Error(`${where}.name: expected lower-case letters, digits and -`);
    }
    if (informedBy !== undefined && (typeof informedBy !== 'string' || !(inputs as string[]).includes(informedBy))) {
      throw new Error(`${where}.informedBy: expected one of the inputs`);
    }
    if (task !== undefined) parseTask(task, `${where}.task`);
    const required = requires === undefined ? undefined : parseRequires(requires, inputs as string[], `${where}.requires`);
    if (required && informedBy !== undefined) throw new Error(`${where}: use requires or informedBy, not both`);
    // One unnamed route per type, and every name once.
    const key = name === undefined ? `type:${String(type)}` : `name:${name}`;
    if (seen.has(key)) {
      throw new Error(name === undefined ? `${where}: type ${String(type)} has two routes without a name` : `${where}: name ${name} is listed twice`);
    }
    seen.add(key);
    return {
      type, profile, inputs, attribute,
      ...(decisionEntity !== undefined && { decisionEntity }),
      ...(reviewActions !== undefined && { reviewActions }),
      ...(name !== undefined && { name }),
      ...(informedBy !== undefined && { informedBy }),
      ...(task !== undefined && { task }),
      ...(required && { requires: required }),
    } as Route;
  });
  requiresCycle(routes);
  return routes;
}

// As profile names of required decisions (schema $defs/name): not an Object.prototype member.
const REQUIREMENT_NAME = /^(?!(?:__proto__|constructor|prototype|toString|toLocaleString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__)$)[A-Za-z0-9_.-]{1,100}$/;

function parseRequires(requires: unknown, inputs: string[], where: string): Record<string, Requirement> {
  if (!requires || typeof requires !== 'object' || Array.isArray(requires) || Object.keys(requires).length === 0) {
    throw new Error(`${where}: expected an object of names and attributes`);
  }
  const entries = Object.entries(requires as Record<string, unknown>);
  // As Pointsman takes them: at most 8 decisions.
  if (entries.length > 8) throw new Error(`${where}: at most 8 decisions`);
  const out: Record<string, Requirement> = {};
  for (const [name, spec] of entries) {
    if (!REQUIREMENT_NAME.test(name)) throw new Error(`${where}: ${name} is not a valid name`);
    const r = typeof spec === 'string' ? { attribute: spec } : spec;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`${where}.${name}: expected an attribute name or an object`);
    const { attribute, rerunOnReview, optional, ...rest } = r as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length) throw new Error(`${where}.${name}: unknown option ${unknown[0]}`);
    // An input, so that a new decision there is a new input (loop guard).
    if (typeof attribute !== 'string' || !inputs.includes(attribute)) throw new Error(`${where}.${name}.attribute: expected one of the inputs`);
    if (rerunOnReview !== undefined && typeof rerunOnReview !== 'boolean') throw new Error(`${where}.${name}.rerunOnReview: expected true or false`);
    if (optional !== undefined && typeof optional !== 'boolean') throw new Error(`${where}.${name}.optional: expected true or false`);
    if (Object.values(out).some((x) => x.attribute === attribute)) throw new Error(`${where}.${name}: attribute ${attribute} is used twice`);
    out[name] = { attribute, ...(rerunOnReview && { rerunOnReview }), ...(optional && { optional }) };
  }
  return out;
}

/**
 * Routes that require each other in a circle, through the attributes they
 * write and read, would run each other again without end: refused.
 */
function requiresCycle(routes: Route[]): void {
  const label = (r: Route) => r.name ?? r.type;
  // The routes whose result a route reads: same type, attribute among its
  // inputs (a new decision there runs it again, required or not).
  const reads = (r: Route) => routes.filter((p) => p !== r && p.type === r.type && r.inputs.includes(p.attribute));
  const done = new Set<Route>();
  const visit = (r: Route, path: Route[]) => {
    if (path.includes(r)) {
      throw new Error(`bridge routes: ${[...path.slice(path.indexOf(r)), r].map(label).join(' → ')} read each other's results in a circle`);
    }
    if (done.has(r)) return;
    for (const p of reads(r)) visit(p, [...path, r]);
    done.add(r);
  };
  for (const r of routes) visit(r, []);
}

function parseTask(task: unknown, where: string): void {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`${where}: expected an object`);
  const { actions, name, priority, ...rest } = task as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${where}: unknown option ${unknown[0]}`);
  if (!Array.isArray(actions) || actions.length === 0 || !actions.every((x) => typeof x === 'string' && x !== '')) {
    throw new Error(`${where}.actions: expected a non-empty list of action names`);
  }
  if (name !== undefined && (typeof name !== 'string' || name === '')) throw new Error(`${where}.name: expected an attribute name`);
  if (priority !== undefined) {
    if (!priority || typeof priority !== 'object' || Array.isArray(priority)) throw new Error(`${where}.priority: expected an object`);
    for (const [action, p] of Object.entries(priority)) {
      if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 9) throw new Error(`${where}.priority.${action}: expected 1 to 9`);
    }
  }
}
