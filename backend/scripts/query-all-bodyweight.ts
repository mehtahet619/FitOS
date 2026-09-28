const { db } = require('../dist/db/client');

async function main() {
  const bodyweightExercises = await db.all(`
    SELECT e.id, e.name, e.primaryMuscle, e.movementPattern
    FROM Exercise e
    LEFT JOIN ExerciseEquipment ee ON ee.exerciseId = e.id
    WHERE ee.exerciseId IS NULL
  `);
  console.log('All bodyweight exercises:', bodyweightExercises.map((e: any) => e.name));
}

main().catch(console.error);