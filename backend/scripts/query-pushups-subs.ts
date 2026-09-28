const { db } = require('../dist/db/client');

async function main() {
  const pushups = await db.get(`SELECT * FROM Exercise WHERE name = 'Push-ups'`);
  console.log('Push-ups:', pushups);
  const subs = await db.all(`SELECT * FROM ExerciseSubstitution WHERE baseExerciseId = ?`, pushups.id);
  console.log('Substitutions for Push-ups:', subs);
  
  // Check what exercises have Push-ups as a substitute
  const reverse = await db.all(`SELECT * FROM ExerciseSubstitution WHERE substituteId = ?`, pushups.id);
  console.log('Exercises that substitute to Push-ups:', reverse);
}

main().catch(console.error);