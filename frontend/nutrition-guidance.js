/* Evidence-informed, non-medical nutrition guidance for FitOS. */
(() => {
  "use strict";
  const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  function assess({ nutrients = {}, servingGrams = 100, targets = {}, profile = {} } = {}) {
    const factor = Math.max(0, Number(servingGrams) || 0) / 100;
    const actual = {};
    for (const key of ["caloriesKcal","proteinG","carbsG","fatG","fiberG","sugarsG","saturatedFatG","sodiumMg","caffeineMg"]) {
      const value = finite(nutrients[key]);
      actual[key] = value === null ? null : value * factor;
    }
    const weight = finite(profile.weightKg);
    const age = finite(profile.age);
    const targetMap = {
      caloriesKcal: finite(targets.calorieTarget ?? targets.calorieTargetKcal),
      proteinG: finite(targets.proteinTargetG) ?? (weight !== null ? weight * 1.2 : null),
      carbsG: finite(targets.carbTargetG),
      fatG: finite(targets.fatTargetG),
      fiberG: 25,
      sugarsG: 50,
      saturatedFatG: 20,
      sodiumMg: 2000,
      caffeineMg: age !== null && age < 18 ? 0 : 400
    };
    const labels = { caloriesKcal:"energy", proteinG:"protein", carbsG:"carbohydrate", fatG:"fat", fiberG:"fibre", sugarsG:"total sugars", saturatedFatG:"saturated fat", sodiumMg:"sodium", caffeineMg:"caffeine" };
    const notes = [];
    for (const key of Object.keys(targetMap)) {
      const value = actual[key], target = targetMap[key];
      if (value === null) continue;
      if (key === "caffeineMg" && age !== null && age < 18) {
        if (value > 0) notes.push("Caffeine is not recommended for children and adolescents; seek age-appropriate guidance.");
        continue;
      }
      if (key === "sugarsG" && value > 25) notes.push("This serving provides over half of the general 50 g/day free-sugar reference. Product total sugars are not necessarily all free sugars.");
      else if (key === "saturatedFatG" && value > 5) notes.push("This serving is relatively high in saturated fat; compare with the rest of the day's intake.");
      else if (key === "sodiumMg" && value >= 600) notes.push("This serving supplies a substantial share of the 2,000 mg/day sodium limit.");
      else if (key === "fiberG" && value >= 3) notes.push("This serving contributes useful fibre toward the general 25 g/day reference.");
      else if (key === "proteinG" && target !== null && value >= target * 0.2) notes.push("This serving makes a meaningful contribution to your protein target.");
      if (target !== null) {
        const remaining = target - value;
        notes.push(labels[key] + ": " + value.toFixed(1) + " of " + target.toFixed(1) + (remaining >= 0 ? " target; " + remaining.toFixed(1) + " remaining." : "; " + Math.abs(remaining).toFixed(1) + " above the reference."));
      }
    }
    if (actual.carbsG !== null && actual.fiberG !== null && actual.carbsG > 30 && actual.fiberG < 2) notes.push("High carbohydrate with little fibre can be less filling; carbohydrates themselves are not inherently unhealthy.");
    if (notes.length === 0) notes.push("Not enough nutrition data to assess this serving reliably. Check the package label; missing values are not treated as zero.");
    return { actual, targets: targetMap, notes };
  }
  window.FitOSNutritionGuidance = { assess };
})();
