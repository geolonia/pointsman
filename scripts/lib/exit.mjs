// Exit once stdout and stderr have written everything. On a pipe a write can
// be queued, and process.exit() drops what is still queued (#351, #352).
//
// The promise never settles, so `await exit(code)` stops the caller there,
// as process.exit() did: nothing after it runs, and the process ends with
// `code` as soon as both streams have flushed.

/** @param {number} code */
export function exit(code) {
  process.exitCode = code;
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  return new Promise(() => {});
}
