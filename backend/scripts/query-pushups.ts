const { db } = require('../dist/db/client');

async function main() {
  const pushups = await db.get(`SELECT * FROM Exercise WHERE name = 'Push-ups'`);
  console.log('Push-ups:', pushups);
  const eq = await db.all(`SELECT * FROM ExerciseEquipment WHERE exerciseId = ?`, pushups.id);
  console.log('Push-ups equipment:', eq);

  const bench = await db.get(`SELECT * FROM Exercise WHERE name = 'Barbell Bench Press'`);
  console.log('Bench Press:', bench);
  const benchEq = await db.all(`SELECT * FROM ExerciseEquipment WHERE exerciseId = ?`, bench.id);
  console.log('Bench Press equipment:', benchEq);
}

main().catch(console.error);