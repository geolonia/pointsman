// Loaded with --import into a script under test: each stdout and stderr
// write completes a little later, as when a non-blocking pipe is full and
// libuv queues the write (slow-stdout.mjs does this for stdout only). A
// script that calls process.exit() right after printing then loses what is
// still queued on either stream.
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    const enc = typeof encoding === 'function' ? undefined : encoding;
    setTimeout(() => write(chunk, enc, done), 5);
    return false;
  };
}
