// Loaded with --import into a script under test: each stdout write
// completes a little later, as when a non-blocking pipe is full and libuv
// queues the write. A script that calls process.exit() right after printing
// then loses what is still queued, as test-profile.mjs lost its summary line
// on CI.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback;
  const enc = typeof encoding === 'function' ? undefined : encoding;
  setTimeout(() => write(chunk, enc, done), 5);
  return false;
};
