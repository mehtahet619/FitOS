const { db } = require('../dist/db/client');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const pushups = await db.get(`SELECT id FROM Exercise WHERE name = 'Push-ups'`);
  if (!pushups) {
    console.error('Push-ups not found');
    return;
  }
  console.log('Push-ups id:', pushups.id);

  // Find equipment-based chest exercises that could be substitutes
  const chestExercises = await db.all(`
    SELECT e.id, e.name, e.primaryMuscle, e.movementPattern, e.difficulty
    FROM Exercise e
    WHERE e.primaryMuscle = 'chest' AND e.name != 'Push-ups'
    ORDER BY e.difficulty ASC, e.name
  `);
  console.log('Chest exercises for substitution:', chestExercises.map((e) => e.name));

  // Add substitution entries for Push-ups
  // Priority 0 = closest substitute
  const substitutes = [
    { name: 'Dumbbell Bench Press', priority: 0 },
    { name: 'Barbell Bench Press', priority: 1 },
    { name: 'Cable Chest Press', priority: 2 },
    { name: 'Dumbbell Fly', priority: 3 },
    { name: 'Floor Dumbbell Press', priority: 4 },
    { name: 'Resistance Band Chest Press', priority: 5 },
  ];

  for (const sub of substitutes) {
    const subExercise = await db.get(`SELECT id FROM Exercise WHERE name = ?`, sub.name);
    if (subExercise) {
      await db.run(
        `INSERT INTO ExerciseSubstitution (id, baseExerciseId, substituteId, priority) VALUES (?, ?, ?, ?)
         ON CONFLICT(baseExerciseId, substituteId) DO UPDATE SET priority = excluded.priority`,
        uuidv4(), pushups.id, subExercise.id, sub.priority
      );
      console.log(`Added substitution: Push-ups -> ${sub.name} (priority ${sub.priority})`);
    } else {
      console.warn(`Exercise not found: ${sub.name}`);
    }
  }

  // Also add substitutions for Diamond Push-ups
  const diamondPushups = await db.get(`SELECT id FROM Exercise WHERE name = 'Diamond Push-ups'`);
  if (diamondPushups) {
    const tricepsSubs = [
      { name: 'Cable Triceps Pushdown', priority: 0 },
      { name: 'Overhead Dumbbell Triceps Extension', priority: 1 },
      { name: 'Close-Grip Bench Press', priority: 2 },
      { name: 'Resistance Band Triceps Pushdown', priority: 3 },
    ];
    for (const sub of tricepsSubs) {
      const subExercise = await db.get(`SELECT id FROM Exercise WHERE name = ?`, sub.name);
      if (subExercise) {
        await db.run(
          `INSERT INTO ExerciseSubstitution (id, baseExerciseId, substituteId, priority) VALUES (?, ?, ?, ?)
           ON CONFLICT(baseExerciseId, substituteId) DO UPDATE SET priority = excluded.priority`,
          uuidv4(), diamondPushups.id, subExercise.id, sub.priority
        );
        console.log(`Added substitution: Diamond Push-ups -> ${sub.name} (priority ${sub.priority})`);
      }
    }
  }

  // Pike Push-ups substitutions
  const pikePushups = await db.get(`SELECT id FROM Exercise WHERE name = 'Pike Push-ups'`);
  if (pikePushups) {
    const shoulderSubs = [
      { name: 'Dumbbell Shoulder Press', priority: 0 },
      { name: 'Barbell Overhead Press', priority: 1 },
      { name: 'Resistance Band Overhead Press', priority: 2 },
    ];
    for (const sub of shoulderSubs) {
      const subExercise = await db.get(`SELECT id FROM Exercise WHERE name = ?`, sub.name);
      if (subExercise) {
        await db.run(
          `INSERT INTO ExerciseSubstitution (id, baseExerciseId, substituteId, priority) VALUES (?, ?, ?, ?)
           ON CONFLICT(baseExerciseId, substituteId) DO UPDATE SET priority = excluded.priority`,
          uuidv4(), pikePushups.id, subExercise.id, sub.priority
        );
        console.log(`Added substitution: Pike Push-ups -> ${sub.name} (priority ${sub.priority})`);
      }
    }
  }

  // Bodyweight chest exercises that could substitute for each other
  const bodyweightChest = ['Push-ups', 'Diamond Push-ups', 'Incline Push-Up', 'Decline Push-Up', 'Clock Push-Up'];
  for (const baseName of bodyweightChest) {
    const base = await db.get(`SELECT id FROM Exercise WHERE name = ?`, baseName);
    if (!base) continue;
    
    for (const subName of bodyweightChest) {
      if (subName === baseName) continue;
      const sub = await db.get(`SELECT id FROM Exercise WHERE name = ?`, subName);
      if (!sub) continue;
      
      await db.run(
        `INSERT INTO ExerciseSubstitution (id, baseExerciseId, substituteId, priority) VALUES (?, ?, ?, ?)
         ON CONFLICT(baseExerciseId, substituteId) DO UPDATE SET priority = excluded.priority`,
        uuidv4(), base.id, sub.id, bodyweightChest.indexOf(subName)
      );
    }
    console.log(`Added bodyweight substitutions for ${baseName}`);
  }

  console.log('Done adding substitutions');
}

main().catch(console.error);