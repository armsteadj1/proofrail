// Fake local Jev command: reads a TypeSafe-shaped request on stdin and answers
// every question with a fixed, obviously synthetic value.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  const answers = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.25 };
    else if (q.type === 'choice') {
      const first = Object.keys(q.criteria)[0];
      answers[id] = { type: 'choice', choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
    } else answers[id] = { type: 'score', score: 1, probabilities: { 1: 1 }, confidence: 1 };
  }
  process.stdout.write(JSON.stringify({ model: req.model, answers, usage: { input_tokens: 1, output_tokens: 1 }, echo: { claim: req.state.claim.id } }));
});
