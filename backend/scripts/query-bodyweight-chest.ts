const { db } = require('../dist/db/client');

async function main() {
  const chestBodyweight = await db.all(`
    SELECT e.id, e.name, e.primaryMuscle, e.secondaryMuscles, e.movementPattern, e.difficulty, e.defaultSets, e.repRangeLow, e.repRangeHigh 
    FROM Exercise e
    LEFT JOIN ExerciseEquipment ee ON ee.exerciseId = e.id
    WHERE e.primaryMuscle = 'chest' AND ee.exerciseId IS NULL
  `);
  console.log('Chest bodyweight exercises:', chestBodyweight);
}

main().catch(console.error);