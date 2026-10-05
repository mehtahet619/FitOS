-- Adaptive Fitness + Food Discovery — schema
--
-- Written as plain SQL against SQLite so the MVP runs with zero external
-- services (no DB server, no engine binaries to download). The shapes below
-- mirror standard PostgreSQL conventions (uuid primary keys, indexed foreign
-- keys, enums-as-text) so porting to Postgres later is a schema translation,
-- not a redesign: swap AUTOINCREMENT-free TEXT ids for native uuid, and this
-- file becomes a straightforward Postgres DDL script.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS User (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  passwordHash TEXT,
  googleId TEXT UNIQUE,
  name TEXT,
  emailVerified INTEGER NOT NULL DEFAULT 1,
  emailVerifiedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_email_lower ON User(LOWER(email));

CREATE TABLE IF NOT EXISTS PendingRegistration (
  id TEXT PRIMARY KEY,
  userId TEXT REFERENCES User(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  otpHash TEXT,
  otpExpiresAt TEXT,
  otpAttempts INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_registration_expiry ON PendingRegistration(otpExpiresAt);

CREATE TABLE IF NOT EXISTS AuthSession (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  refreshTokenHash TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  revokedAt TEXT,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_session_user ON AuthSession(userId);

CREATE TABLE IF NOT EXISTS PasswordResetChallenge (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  otpHash TEXT,
  otpExpiresAt TEXT,
  otpAttempts INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_expiry ON PasswordResetChallenge(otpExpiresAt);

CREATE TABLE IF NOT EXISTS UserProfile (
  id TEXT PRIMARY KEY,
  userId TEXT UNIQUE NOT NULL REFERENCES User(id),
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT NOT NULL,
  heightCm REAL NOT NULL,
  weightKg REAL NOT NULL,
  fitnessLevel TEXT NOT NULL,
  primaryGoal TEXT NOT NULL,
  daysPerWeek INTEGER NOT NULL,
  sessionMinutes INTEGER NOT NULL,
  dietaryPref TEXT NOT NULL,
  allergies TEXT NOT NULL DEFAULT '',
  foodLikes TEXT NOT NULL DEFAULT '',
  dailyBudget REAL NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Equipment (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  normalizedName TEXT,
  category TEXT,
  isCustom INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS EquipmentAlias (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  equipmentId TEXT NOT NULL REFERENCES Equipment(id),
  UNIQUE(alias, equipmentId)
);
CREATE INDEX IF NOT EXISTS idx_equipment_alias_alias ON EquipmentAlias(alias);

CREATE TABLE IF NOT EXISTS Muscle (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  category TEXT
);

CREATE TABLE IF NOT EXISTS UserEquipment (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  equipmentId TEXT NOT NULL REFERENCES Equipment(id),
  UNIQUE(userId, equipmentId)
);
CREATE INDEX IF NOT EXISTS idx_userequipment_user ON UserEquipment(userId);

CREATE TABLE IF NOT EXISTS GymEquipmentProfile (
  id TEXT PRIMARY KEY,
  userId TEXT UNIQUE NOT NULL REFERENCES User(id),
  equipmentJson TEXT NOT NULL DEFAULT '[]',
  tourCompleted INTEGER NOT NULL DEFAULT 0,
  lastScanAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gymequipmentprofile_user ON GymEquipmentProfile(userId);

CREATE TABLE IF NOT EXISTS Exercise (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  primaryMuscle TEXT NOT NULL,
  secondaryMuscles TEXT NOT NULL DEFAULT '',
  movementPattern TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  defaultSets INTEGER NOT NULL,
  repRangeLow INTEGER NOT NULL,
  repRangeHigh INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  imageUrl TEXT,
  requiresEquipment INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exercise_muscle ON Exercise(primaryMuscle);
CREATE INDEX IF NOT EXISTS idx_exercise_pattern ON Exercise(movementPattern);

CREATE TABLE IF NOT EXISTS ExerciseMuscle (
  id TEXT PRIMARY KEY,
  exerciseId TEXT NOT NULL REFERENCES Exercise(id),
  muscleId TEXT NOT NULL REFERENCES Muscle(id),
  role TEXT NOT NULL CHECK(role IN ('PRIMARY', 'SECONDARY')),
  weight REAL NOT NULL DEFAULT 1.0,
  UNIQUE(exerciseId, muscleId, role)
);
CREATE INDEX IF NOT EXISTS idx_exercisemuscle_exercise ON ExerciseMuscle(exerciseId);
CREATE INDEX IF NOT EXISTS idx_exercisemuscle_muscle ON ExerciseMuscle(muscleId);

CREATE TABLE IF NOT EXISTS ExerciseEquipment (
  id TEXT PRIMARY KEY,
  exerciseId TEXT NOT NULL REFERENCES Exercise(id),
  equipmentId TEXT NOT NULL REFERENCES Equipment(id),
  UNIQUE(exerciseId, equipmentId)
);

CREATE TABLE IF NOT EXISTS ExerciseSubstitution (
  id TEXT PRIMARY KEY,
  baseExerciseId TEXT NOT NULL REFERENCES Exercise(id),
  substituteId TEXT NOT NULL REFERENCES Exercise(id),
  priority INTEGER NOT NULL DEFAULT 0,
  UNIQUE(baseExerciseId, substituteId)
);
CREATE INDEX IF NOT EXISTS idx_sub_base ON ExerciseSubstitution(baseExerciseId);

CREATE TABLE IF NOT EXISTS WorkoutPlan (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  goal TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Workout (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  workoutPlanId TEXT REFERENCES WorkoutPlan(id),
  focus TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  durationMin INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  completedAt TEXT,
  planStepIndex INTEGER,
  cycleId TEXT,
  equipmentMode TEXT NOT NULL DEFAULT 'USER_EQUIPMENT',
  equipmentSnapshot TEXT NOT NULL DEFAULT '[]',
  generatorVersion TEXT
);
CREATE INDEX IF NOT EXISTS idx_workout_user ON Workout(userId);
CREATE INDEX IF NOT EXISTS idx_workout_user_created ON Workout(userId, createdAt DESC);

CREATE TABLE IF NOT EXISTS WorkoutPlanState (
  id TEXT PRIMARY KEY,
  userId TEXT UNIQUE NOT NULL REFERENCES User(id),
  structureKey TEXT NOT NULL,
  cycleId TEXT NOT NULL,
  cycleStatus TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  currentIndex INTEGER NOT NULL DEFAULT 0,
  unitsJson TEXT NOT NULL,
  activeWorkoutId TEXT,
  createdAt TEXT NOT NULL,
  completedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_state_user ON WorkoutPlanState(userId);
CREATE INDEX IF NOT EXISTS idx_plan_state_cycle ON WorkoutPlanState(cycleId);

CREATE TABLE IF NOT EXISTS WorkoutCycleHistory (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  cycleId TEXT NOT NULL,
  structureKey TEXT NOT NULL,
  unitsJson TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  completedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycle_history_user ON WorkoutCycleHistory(userId);
CREATE INDEX IF NOT EXISTS idx_cycle_history_cycle ON WorkoutCycleHistory(cycleId);

CREATE TABLE IF NOT EXISTS WorkoutExercise (
  id TEXT PRIMARY KEY,
  workoutId TEXT NOT NULL REFERENCES Workout(id),
  exerciseId TEXT NOT NULL REFERENCES Exercise(id),
  orderIndex INTEGER NOT NULL,
  targetSets INTEGER NOT NULL,
  repRangeLow INTEGER NOT NULL,
  repRangeHigh INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  replacedFromId TEXT,
  painReported INTEGER NOT NULL DEFAULT 0,
  sourceExerciseName TEXT,
  sourceMuscle TEXT,
  sourcePrimaryMuscle TEXT,
  sourceMachine TEXT
);
CREATE INDEX IF NOT EXISTS idx_we_workout ON WorkoutExercise(workoutId);

CREATE TABLE IF NOT EXISTS WorkoutExerciseSwapHistory (
  workoutExerciseId TEXT NOT NULL REFERENCES WorkoutExercise(id) ON DELETE CASCADE,
  familyKey TEXT NOT NULL,
  exerciseName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workoutExerciseId, familyKey)
);
CREATE INDEX IF NOT EXISTS idx_we_swap_history_slot ON WorkoutExerciseSwapHistory(workoutExerciseId);

CREATE TABLE IF NOT EXISTS WorkoutSet (
  id TEXT PRIMARY KEY,
  workoutExerciseId TEXT NOT NULL REFERENCES WorkoutExercise(id),
  setNumber INTEGER NOT NULL,
  weightKg REAL,
  reps INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS WorkoutHistory (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  exerciseId TEXT NOT NULL,
  weightKg REAL,
  reps INTEGER,
  volumeKg REAL,
  recordedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_user_exercise ON WorkoutHistory(userId, exerciseId);
CREATE INDEX IF NOT EXISTS idx_workouthistory_user_recorded ON WorkoutHistory(userId, recordedAt DESC);

CREATE TABLE IF NOT EXISTS MuscleHistory (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  muscleId TEXT NOT NULL REFERENCES Muscle(id),
  trainedAt TEXT NOT NULL,
  volume REAL,
  intensity REAL,
  role TEXT NOT NULL CHECK(role IN ('PRIMARY', 'SECONDARY')),
  exerciseId TEXT REFERENCES Exercise(id)
);
CREATE INDEX IF NOT EXISTS idx_musclehistory_user ON MuscleHistory(userId);
CREATE INDEX IF NOT EXISTS idx_musclehistory_muscle ON MuscleHistory(muscleId);
CREATE INDEX IF NOT EXISTS idx_musclehistory_trainedat ON MuscleHistory(trainedAt);

CREATE TABLE IF NOT EXISTS EquipmentDetection (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  sessionId TEXT,
  equipmentId TEXT REFERENCES Equipment(id),
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipmentdetection_user ON EquipmentDetection(userId);
CREATE INDEX IF NOT EXISTS idx_equipmentdetection_session ON EquipmentDetection(sessionId);

CREATE TABLE IF NOT EXISTS NutritionProfile (
  id TEXT PRIMARY KEY,
  userId TEXT UNIQUE NOT NULL REFERENCES User(id),
  calorieTarget INTEGER NOT NULL,
  proteinTargetG INTEGER NOT NULL,
  carbTargetG INTEGER NOT NULL,
  fatTargetG INTEGER NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Food (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dietType TEXT NOT NULL,
  calories INTEGER NOT NULL,
  proteinG REAL NOT NULL,
  carbsG REAL NOT NULL,
  fatG REAL NOT NULL,
  allergens TEXT NOT NULL DEFAULT '',
  estPriceInr REAL NOT NULL,
  mealSlot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS NutritionRecommendation (
  id TEXT PRIMARY KEY,
  nutritionProfileId TEXT NOT NULL REFERENCES NutritionProfile(id),
  createdAt TEXT NOT NULL,
  totalCalories INTEGER NOT NULL,
  totalProteinG REAL NOT NULL,
  totalCarbsG REAL NOT NULL,
  totalFatG REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'general-nutrition'
);
CREATE INDEX IF NOT EXISTS idx_nutritionrecommendation_profile_created ON NutritionRecommendation(nutritionProfileId, createdAt DESC);

CREATE TABLE IF NOT EXISTS Meal (
  id TEXT PRIMARY KEY,
  nutritionRecommendationId TEXT REFERENCES NutritionRecommendation(id),
  foodId TEXT NOT NULL REFERENCES Food(id),
  slot TEXT NOT NULL
);

-- Restaurant/RestaurantDish rows are only ever written by a real
-- MapsProvider implementation — the seed script deliberately does not
-- populate these tables. See src/maps/provider.ts.
CREATE TABLE IF NOT EXISTS Restaurant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  distanceKm REAL NOT NULL,
  rating REAL NOT NULL,
  priceRange TEXT NOT NULL,
  isOpenNow INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS RestaurantDish (
  id TEXT PRIMARY KEY,
  restaurantId TEXT NOT NULL REFERENCES Restaurant(id),
  name TEXT NOT NULL,
  estPriceInr REAL NOT NULL,
  estCalories INTEGER,
  estProteinG REAL
);

CREATE TABLE IF NOT EXISTS UserLocation (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  recordedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_userlocation_user ON UserLocation(userId);

CREATE TABLE IF NOT EXISTS ProgressMetric (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  recordedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_user_metric ON ProgressMetric(userId, metric);

CREATE TABLE IF NOT EXISTS PersonalRecord (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  exerciseId TEXT NOT NULL REFERENCES Exercise(id),
  weightKg REAL NOT NULL,
  reps INTEGER NOT NULL,
  estOneRepMax REAL NOT NULL,
  achievedAt TEXT NOT NULL,
  UNIQUE(userId, exerciseId)
);

-- Gym check-in / attendance. One row per user per calendar date, enforced
-- by the UNIQUE constraint below (checked again in application code so the
-- API can return a clean 409 instead of a raw constraint error).
CREATE TABLE IF NOT EXISTS GymAttendance (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES User(id),
  date TEXT NOT NULL, -- YYYY-MM-DD, local server date
  method TEXT NOT NULL, -- 'qr' | 'manual'
  checkedInAt TEXT NOT NULL,
  UNIQUE(userId, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON GymAttendance(userId, date);
