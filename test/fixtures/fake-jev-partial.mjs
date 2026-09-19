process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ answers: { proof_covers_claim: { type: 'noul', noul: 0.5 } } })));
