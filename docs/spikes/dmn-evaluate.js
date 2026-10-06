// Spike code (docs/spikes/dmn-policy-tables.md, issue #13); not used by the engine.
// Evaluate a DMN decision table (hit policy FIRST) with feelin.
import { DmnModdle } from 'dmn-moddle';
import { evaluate, unaryTest } from 'feelin';

export async function loadTable(xml) {
  const { rootElement } = await new DmnModdle().fromXML(xml, 'dmn:Definitions');
  const table = rootElement.drgElement.find((e) => e.$type === 'dmn:Decision').decisionLogic;
  if (table.hitPolicy !== 'FIRST') throw new Error(`hit policy ${table.hitPolicy} not supported`);
  return {
    inputs: table.input.map((i) => i.inputExpression.text),
    output: table.output[0].name,
    rules: table.rule.map((r) => ({ tests: r.inputEntry.map((e) => e.text), result: r.outputEntry[0].text })),
  };
}

export function decide(table, context) {
  const values = table.inputs.map((expr) => evaluate(expr, context).value);
  for (const rule of table.rules) {
    if (rule.tests.every((t, i) => t.trim() === '-' || unaryTest(t, { '?': values[i] }).value === true)) {
      return evaluate(rule.result, context).value;
    }
  }
  return null;
}
