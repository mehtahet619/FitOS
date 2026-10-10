import type { DatabaseLike } from "../../db/types";

export interface MuscleReadinessConfig {
  primaryWeight: number;
  secondaryWeight: number;
  halfLifeHours: number;
  volumeScale: number;
  intensityScale: number;
  minReadiness: number;
  maxReadiness: number;
}

export const DEFAULT_MUSCLE_READINESS_CONFIG: MuscleReadinessConfig = {
  primaryWeight: 1.0,
  secondaryWeight: 0.5,
  halfLifeHours: 48,
  volumeScale: 0.001,
  intensityScale: 0.1,
  minReadiness: 0.1,
  maxReadiness: 1.0,
};

export interface MuscleHistoryEntry {
  [key: string]: unknown;
  id: string;
  userId: string;
  muscleId: string;
  muscleName: string;
  trainedAt: string;
  volume: number;
  intensity: number;
  role: "PRIMARY" | "SECONDARY";
  exerciseId: string | null;
}

export interface MuscleReadiness {
  muscleId: string;
  muscleName: string;
  readiness: number;
  lastTrainedAt: string | null;
  hoursSinceTrained: number | null;
  recentVolume: number;
  recentSessions: number;
  status: "ready" | "recovering" | "fatigued";
}

export class MuscleRecoveryService {
  private config: MuscleReadinessConfig;

  constructor(config: Partial<MuscleReadinessConfig> = {}) {
    this.config = { ...DEFAULT_MUSCLE_READINESS_CONFIG, ...config };
  }

  setConfig(config: Partial<MuscleReadinessConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): MuscleReadinessConfig {
    return { ...this.config };
  }

  async recordMuscleTraining(
    database: DatabaseLike,
    userId: string,
    muscleId: string,
    exerciseId: string,
    role: "PRIMARY" | "SECONDARY",
    volume: number,
    intensity: number,
    trainedAt: string = new Date().toISOString()
  ): Promise<void> {
    const id = crypto.randomUUID();
    await database.run(
      `INSERT INTO MuscleHistory (id, userId, muscleId, trainedAt, volume, intensity, role, exerciseId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, userId, muscleId, trainedAt, volume, intensity, role, exerciseId
    );
  }

  async getMuscleHistory(
    database: DatabaseLike,
    userId: string,
    muscleId: string,
    sinceHours: number = 168
  ): Promise<MuscleHistoryEntry[]> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - sinceHours);
    const cutoffStr = cutoff.toISOString();

    const rows = await database.all<MuscleHistoryEntry>(
      `SELECT mh.*, m.name as muscleName
       FROM MuscleHistory mh
       JOIN Muscle m ON m.id = mh.muscleId
       WHERE mh.userId = ? AND mh.muscleId = ? AND mh.trainedAt >= ?
       ORDER BY mh.trainedAt DESC`,
      userId, muscleId, cutoffStr
    );
    return rows;
  }

  async getAllMuscleHistory(
    database: DatabaseLike,
    userId: string,
    sinceHours: number = 168
  ): Promise<MuscleHistoryEntry[]> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - sinceHours);
    const cutoffStr = cutoff.toISOString();

    const rows = await database.all<MuscleHistoryEntry>(
      `SELECT mh.*, m.name as muscleName
       FROM MuscleHistory mh
       JOIN Muscle m ON m.id = mh.muscleId
       WHERE mh.userId = ? AND mh.trainedAt >= ?
       ORDER BY mh.trainedAt DESC`,
      userId, cutoffStr
    );
    return rows;
  }

  calculateReadiness(
    history: MuscleHistoryEntry[],
    now: Date = new Date()
  ): MuscleReadiness {
    const { primaryWeight, secondaryWeight, halfLifeHours, volumeScale, intensityScale, minReadiness, maxReadiness } = this.config;

    if (history.length === 0) {
      return {
        muscleId: "",
        muscleName: "",
        readiness: maxReadiness,
        lastTrainedAt: null,
        hoursSinceTrained: null,
        recentVolume: 0,
        recentSessions: 0,
        status: "ready",
      };
    }

    const latest = history[0];
    const lastTrainedAt = new Date(latest.trainedAt);
    const hoursSinceTrained = (now.getTime() - lastTrainedAt.getTime()) / (1000 * 60 * 60);

    let fatigue = 0;
    let recentVolume = 0;

    for (const entry of history) {
      const entryTime = new Date(entry.trainedAt);
      const hoursSinceEntry = (now.getTime() - entryTime.getTime()) / (1000 * 60 * 60);

      if (hoursSinceEntry > halfLifeHours * 3) continue;

      const decayFactor = Math.pow(0.5, hoursSinceEntry / halfLifeHours);
      const weight = entry.role === "PRIMARY" ? primaryWeight : secondaryWeight;
      const entryFatigue = (entry.volume * volumeScale + entry.intensity * intensityScale) * weight * decayFactor;
      fatigue += entryFatigue;
      recentVolume += entry.volume;
    }

    const rawReadiness = Math.max(0, 1 - fatigue);
    const readiness = Math.min(maxReadiness, Math.max(minReadiness, rawReadiness));

    let status: "ready" | "recovering" | "fatigued" = "ready";
    if (readiness < 0.4) status = "fatigued";
    else if (readiness < 0.75) status = "recovering";

    return {
      muscleId: latest.muscleId,
      muscleName: latest.muscleName,
      readiness: Math.round(readiness * 100) / 100,
      lastTrainedAt: latest.trainedAt,
      hoursSinceTrained: Math.round(hoursSinceTrained * 10) / 10,
      recentVolume: Math.round(recentVolume * 10) / 10,
      recentSessions: history.length,
      status,
    };
  }

  async getAllMuscleReadiness(
    database: DatabaseLike,
    userId: string,
    sinceHours: number = 168
  ): Promise<MuscleReadiness[]> {
    const history = await this.getAllMuscleHistory(database, userId, sinceHours);
    const byMuscle = new Map<string, MuscleHistoryEntry[]>();

    for (const entry of history) {
      if (!byMuscle.has(entry.muscleId)) {
        byMuscle.set(entry.muscleId, []);
      }
      byMuscle.get(entry.muscleId)!.push(entry);
    }

    const results: MuscleReadiness[] = [];
    for (const [muscleId, entries] of byMuscle.entries()) {
      const readiness = this.calculateReadiness(entries);
      readiness.muscleId = muscleId;
      readiness.muscleName = entries[0].muscleName;
      results.push(readiness);
    }

    return results.sort((a, b) => a.readiness - b.readiness);
  }

  async getMuscleReadiness(
    database: DatabaseLike,
    userId: string,
    muscleId: string,
    sinceHours: number = 168
  ): Promise<MuscleReadiness> {
    const history = await this.getMuscleHistory(database, userId, muscleId, sinceHours);
    const readiness = this.calculateReadiness(history);
    readiness.muscleId = muscleId;
    readiness.muscleName = history[0]?.muscleName || "";
    return readiness;
  }

  filterExercisesByReadiness(
    exercises: Array<{ primaryMuscle: string; secondaryMuscles?: string[] }>,
    muscleReadiness: MuscleReadiness[],
    minReadiness: number = 0.5
  ): Array<{ exercise: any; readiness: number; warning?: string }> {
    const readinessMap = new Map(muscleReadiness.map(m => [m.muscleId, m]));
    const nameToIdMap = new Map(muscleReadiness.map(m => [m.muscleName.toLowerCase(), m.muscleId]));

    return exercises.map(ex => {
      const primaryId = nameToIdMap.get(ex.primaryMuscle.toLowerCase());
      const primaryReadiness = primaryId ? readinessMap.get(primaryId)?.readiness ?? 1 : 1;

      let secondaryReadiness = 1;
      if (ex.secondaryMuscles && ex.secondaryMuscles.length > 0) {
        const secondaryIds = ex.secondaryMuscles
          .map(m => nameToIdMap.get(m.toLowerCase()))
          .filter(Boolean) as string[];
        if (secondaryIds.length > 0) {
          secondaryReadiness = Math.min(...secondaryIds.map(id => readinessMap.get(id)?.readiness ?? 1));
        }
      }

      const overallReadiness = Math.min(primaryReadiness, secondaryReadiness);
      let warning: string | undefined;

      if (overallReadiness < minReadiness) {
        const fatiguedMuscles = [];
        if (primaryReadiness < minReadiness) fatiguedMuscles.push(ex.primaryMuscle);
        if (ex.secondaryMuscles) {
          for (const m of ex.secondaryMuscles) {
            const id = nameToIdMap.get(m.toLowerCase());
            if (id && (readinessMap.get(id)?.readiness ?? 1) < minReadiness) {
              fatiguedMuscles.push(m);
            }
          }
        }
        warning = `Low readiness for: ${fatiguedMuscles.join(", ")}`;
      }

      return {
        exercise: ex,
        readiness: Math.round(overallReadiness * 100) / 100,
        warning,
      };
    });
  }
}

export const muscleRecoveryService = new MuscleRecoveryService();
