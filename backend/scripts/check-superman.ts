const { db } = require('../dist/db/client');

async function main() {
  const superman = await db.get(`SELECT * FROM Exercise WHERE name LIKE '%Superman%'`);
  console.log('Superman Rows:', superman);
  if (superman) {
    const eq = await db.all(`SELECT * FROM ExerciseEquipment WHERE exerciseId = ?`, superman.id);
    console.log('Superman Rows equipment:', eq);
  }
  
  // Check all bodyweight exercises
  const bodyweight = await db.all(`
    SELECT e.id, e.name, e.primaryMuscle
    FROM Exercise e
    LEFT JOIN ExerciseEquipment ee ON ee.exerciseId = e.id
    WHERE ee.exerciseId IS NULL
  `);
  console.log('All bodyweight exercises:', bodyweight.map((e: any) => e.name));
}

main().catch(console.error);