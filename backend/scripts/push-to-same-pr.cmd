@echo off
REM === Run this OUTSIDE the IDE sandbox: double-click or run in a normal cmd/PowerShell window ===
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0\..\..\.."

echo.
echo [1/5] Staging files...
"C:\Program Files\Git\cmd\git.exe" add ^
  backend\src\db\schema.sql ^
  backend\src\db\migrate.ts ^
  backend\src\db\migrate-postgres.ts ^
  backend\src\modules\workouts\plan.ts ^
  backend\src\modules\workouts\routes.ts ^
  backend\src\__tests__\workoutPlan.test.ts ^
  frontend\app.js ^
  frontend\styles.css
if errorlevel 1 goto :err

echo.
echo [2/5] Status after staging:
"C:\Program Files\Git\cmd\git.exe" --no-pager status --short

echo.
echo [3/5] Committing...
"C:\Program Files\Git\cmd\git.exe" commit -m "[IMP] workouts: enforce cycle-locked plan progression (PPL/INDIVIDUAL/BRO)

- DB: add cycleId column to WorkoutPlanState + WorkoutCycleHistory archive
  table, with SQLite + Postgres safe migrations.
- plan.ts: deterministic state machine service layer exposing
  getActiveWorkoutPlan, getCurrentCycle, getWorkoutHistory,
  getCompletedWorkoutUnits, getRemainingWorkoutUnits,
  getNextRequiredWorkout, getRecentlyTrainedMuscles, canSwitchPlan,
  completeWorkoutUnit, startNewWorkoutCycle, switchWorkoutPlan,
  getTodayWorkoutDecision, getCycleHistory, getExercisesForWorkout.
  Strictly distinguishes remaining (slice from currentIndex) vs next
  (ordered index access) so PPL after Push shows Pull+Legs remaining
  but only Pull as the required next unit.
- routes.ts: new endpoints /plan/structures, /plan/cycle-history,
  /plan/recently-trained, /plan/next-workout, /plan/today-decision,
  /exercises-for-next, /history, and POST /plan/start-cycle.
  Backend-enforced locks: POST /plan returns 409 for IN_PROGRESS
  cycles and POST /generate rejects mismatched focus overrides; only
  the plan order can select today's workout. Equipment availability
  filters exercises AFTER the workout unit is chosen.
- workoutPlan.test.ts: InMemoryDb double + 14 describe blocks covering
  Scenarios A (PPL full cycle unlock), B (PPL remaining/not-next distinction
  + switch LOCKED), C (Individual 6-step progression), D (early switch
  REJECT), E (Bro split progression + mid-cycle switch blocked), plus
  completeWorkoutUnit activeWorkoutId mismatch guard, startNewWorkoutCycle
  transition, switchWorkoutPlan new-user + post-unlock happy paths,
  buildCycleId format, and getTodayWorkoutDecision / getNextRequiredWorkout.
- frontend/app.js + styles.css: structure-picker onboarding, active plan
  card with lock/unlock pills, visual cycle progress bar (done/next/pending
  nodes + connectors), completed/remaining unit lists, Plan Context card
  inside each workout, cycle restart / switch buttons gated on COMPLETED,
  and success banners surfacing cycleCompleted + nextUnit after complete."
if errorlevel 1 goto :err

echo.
echo [4/5] HEAD log:
"C:\Program Files\Git\cmd\git.exe" --no-pager log -1 --oneline

echo.
echo [5/5] Pushing (force-with-lease) to existing PR branch...
"C:\Program Files\Git\cmd\git.exe" push --force-with-lease --porcelain
if errorlevel 1 (
  echo ^> plain push failed, retrying with --set-upstream origin fix/weekly-muscle-rotation...
  "C:\Program Files\Git\cmd\git.exe" push --set-upstream origin fix/weekly-muscle-rotation --force-with-lease --porcelain
  if errorlevel 1 goto :err
)

echo.
echo === PUSH OK - same PR updated ===
exit /b 0

:err
echo.
echo FAILED (exit %ERRORLEVEL%). Fix above and rerun %~f0.
exit /b 1
