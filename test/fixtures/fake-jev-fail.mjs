process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('jev backend down');
  process.exit(3);
});
