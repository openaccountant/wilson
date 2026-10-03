/**
 * Round-2 measurement tooling (no product code): merges per-row human grades into run records so
 * scoreRound2 can compute local precision. Grades are keyed by question text and always carry a
 * reason; an answered row without a grade is an error (ungraded answers are never assumed correct).
 */

/** A mutation request is marked by the set writer's own answerNotes (or an explicit mutation flag). */
export function isMutationRow(row) {
  if (row.mutation === true) return true;
  return row.expect === 'none' && /^mutation request/i.test(row.answerNotes ?? '');
}

/** grades: { [q]: { answerOk: boolean, useless?: boolean, why: string } } */
export function applyGrades(records, grades) {
  const answered = new Map(records.filter((r) => r.outcome === 'answer').map((r) => [r.q, r]));
  const problems = [];
  for (const [q, g] of Object.entries(grades)) {
    if (!answered.has(q)) problems.push(`grade for "${q}": row not answered locally or not in run`);
    else if (typeof g.answerOk !== 'boolean') problems.push(`grade for "${q}": answerOk must be boolean`);
    else if (typeof g.why !== 'string' || !g.why.trim()) problems.push(`grade for "${q}": why is required`);
  }
  const ungraded = [...answered.keys()].filter((q) => !(q in grades));
  if (ungraded.length) problems.push(`ungraded answered rows: ${ungraded.map((q) => JSON.stringify(q)).join(', ')}`);
  if (problems.length) throw new Error(problems.join('\n'));
  return records.map((r) => {
    const g = grades[r.q];
    if (r.outcome !== 'answer' || !g) return r;
    return { ...r, answerOk: g.answerOk, useless: g.useless === true ? true : false, gradeWhy: g.why };
  });
}
