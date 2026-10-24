// `## Heading {#id}` in Markdown: the heading gets that id instead of one
// made from its text. The Japanese translations of the older English pages
// use it, so that a link to `profile-format.md#facts` lands on the same
// section in both languages. Without `{#id}` nothing changes.

const ID = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

function visit(node, fn) {
  fn(node);
  for (const child of node.children ?? []) visit(child, fn);
}

export default function headingIds() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type !== 'heading') return;
      const last = node.children?.at(-1);
      if (last?.type !== 'text') return;
      const m = ID.exec(last.value);
      if (!m) return;
      last.value = last.value.slice(0, m.index);
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, id: m[1] };
    });
  };
}
