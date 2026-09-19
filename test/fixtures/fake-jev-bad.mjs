process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('this is not json'));
