// The pull request's description as the connector sends it to Pointsman
// (docs/github-connector.md): cut to a size, and without CodeRabbit's
// summary blocks, so a bot's edit neither reaches the model nor asks a
// once_per_head profile again. The run uses it (pull-request.ts).

/** Same as the shadow poller: enough for the AI questions, keeps a very long description out of the model. */
export const MAX_TITLE = 300;
export const MAX_BODY = 8000;
/** CodeRabbit's summary in the description, between these markers: written by a bot, not by the author. */
const BOT_BLOCK_START = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
const BOT_BLOCK_END = '<!-- end of auto-generated comment: release notes by coderabbit.ai -->';

/**
 * The description as the author wrote it: CodeRabbit's summary blocks left
 * out, only whole ones (a start marker without an end marker after it stays
 * text). So its edits neither ask a once_per_head profile again nor reach
 * the model. The author cannot claim more than they wrote this way: they
 * control the description anyway, and the facts come from GitHub.
 */
export function authorText(body: string): string {
  let out = '';
  let rest = body;
  for (;;) {
    const i = rest.indexOf(BOT_BLOCK_START);
    const end = i < 0 ? -1 : rest.indexOf(BOT_BLOCK_END, i + BOT_BLOCK_START.length);
    if (end < 0) break;
    out += rest.slice(0, i);
    rest = rest.slice(end + BOT_BLOCK_END.length);
  }
  // Without a block, the author's text exactly (an indented code block keeps its spaces);
  // with one, the space left around it is trimmed.
  return rest.length === body.length ? body : (out + rest).trim();
}
