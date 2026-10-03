export function isMutationRow(row: { q?: string; expect: string; answerNotes?: string; mutation?: boolean }): boolean;
export function applyGrades<T extends { q: string; outcome: string }>(
  records: T[],
  grades: Record<string, { answerOk: boolean; useless?: boolean; why: string }>
): Array<T & { answerOk?: boolean; useless?: boolean; gradeWhy?: string }>;
