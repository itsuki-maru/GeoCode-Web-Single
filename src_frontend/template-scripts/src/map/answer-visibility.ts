/** Independent masks ensure legend toggles cannot undo answer filters or searches. */
export function createAnswerVisibility(rebuild: () => void) {
  let answers: Set<string> | null = null;
  let hidden = new Set<string>();
  const update = (keys: string[], legend: boolean) => {
    const previousAnswers = answers;
    const previousHidden = hidden;
    try {
      if (legend) hidden = new Set(keys);
      else answers = new Set(keys);
      rebuild();
    } catch (error) {
      answers = previousAnswers;
      hidden = previousHidden;
      rebuild();
      throw error;
    }
  };
  return {
    allows: (key: string) => (!answers || answers.has(key)) && !hidden.has(key),
    setAnswerTargets: (keys: string[]) => update(keys, false),
    setLegendHiddenTargets: (keys: string[]) => update(keys, true),
  };
}
