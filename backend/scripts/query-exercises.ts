const { db } = require('../dist/db/client');

async function main() {
  const pushExercises = await db.all(`SELECT id, name, primaryMuscle, secondaryMuscles, movementPattern, difficulty, defaultSets, repRangeLow, repRangeHigh FROM Exercise WHERE name LIKE '%Push%'`);
  console.log('Push exercises:', pushExercises);

  const benchExercises = await db.all(`SELECT id, name, primaryMuscle, secondaryMuscles, movementPattern, difficulty, defaultSets, repRangeLow, repRangeHigh FROM Exercise WHERE name LIKE '%Bench%'`);
  console.log('Bench exercises:', benchExercises);

  const allExercises = await db.all(`SELECT id, name, primaryMuscle, secondaryMuscles, movementPattern, difficulty, defaultSets, repRangeLow, repRangeHigh FROM Exercise`);
  console.log('All exercises count:', allExercises.length);
}

main().catch(console.error);